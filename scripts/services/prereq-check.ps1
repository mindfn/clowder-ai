<#
.SYNOPSIS
  Shared prerequisite check for ML service install scripts on Windows.
.DESCRIPTION
  Provides Resolve-BootstrapPython (finds py/python) and Assert-Python310
  (checks version >= 3.10). Source this at the top of each install script.
#>

function Resolve-BootstrapPython {
    # Delegate to the shared resolver (python-resolve.ps1). The resolver
    # walks the same priority list as the *.sh sister script:
    #   1. System Python (PATH, AMD64 only on Windows ARM64)
    #   2. Reuse uv if the user already has it (never auto-installs uv)
    #   3. Project-owned Python at ~/.cat-cafe/python/
    #   4. Last resort: download python.org installer and silent-install
    #      to the project dir (PrependPath=0, no system pollution)
    #
    # Step 4 hits the network — call Sync-SystemProxy first so HTTP_PROXY /
    # HTTPS_PROXY are populated from the Windows registry before any download.
    # Otherwise users behind a corporate / WSL Proxy proxy would see Step 4
    # fail to reach python.org while the subsequent Assert-Network already
    # ran in another path. Sync-SystemProxy is idempotent.
    Sync-SystemProxy
    . "$PSScriptRoot\python-resolve.ps1"
    $info = Resolve-Python312   # throws on hard failure
    Write-Host ("  Python {0}: {1} [OK] (arch={2})" -f $info.Source, $info.Path, $info.Machine)
    return [pscustomobject]@{
        Path = $info.Path
        PrefixArgs = $info.PrefixArgs
        Machine = $info.Machine
    }
}

function Assert-Python310 {
    param([pscustomobject]$Bootstrap)
    $pyCmd = 'import sys; print(sys.version_info[0], sys.version_info[1], sep=chr(46))'
    $ver = & $Bootstrap.Path @($Bootstrap.PrefixArgs + @('-c', $pyCmd))
    if (-not $ver) {
        Write-Error "ERROR: Could not determine Python version. Ensure Python is correctly installed."
        exit 1
    }
    $parts = "$ver".Trim() -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
        Write-Error "ERROR: Python $ver too old, need 3.10+."
        exit 1
    }
    Write-Host "  Python $ver [OK]"
}

function Assert-DiskSpace {
    param([int]$RequiredGB = 2)
    # $env:CAT_CAFE_HOME is exported by python-resolve.ps1 (sourced via
    # Resolve-BootstrapPython before disk space gets checked). Fall back to
    # legacy ~/.cat-cafe if a caller invokes Assert-DiskSpace standalone.
    $targetDir = if ($env:CAT_CAFE_HOME) { $env:CAT_CAFE_HOME } else { Join-Path $HOME ".cat-cafe" }
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    $drive = (Resolve-Path $targetDir).Drive
    $freeGB = [math]::Floor((Get-PSDrive $drive.Name).Free / 1GB)
    if ($freeGB -lt $RequiredGB) {
        Write-Error "ERROR: Disk space insufficient. Need ${RequiredGB}GB, available ${freeGB}GB ($targetDir)"
        exit 1
    }
    Write-Host "  Disk space: ${freeGB}GB available [OK]"
}

function Test-ProxyAnonymous {
    # Probe a proxy WITH NO CREDENTIALS — this matches what pip /
    # huggingface_hub / curl will do once we set HTTP_PROXY. PowerShell's
    # default Invoke-WebRequest auto-fills the logged-in Windows user's
    # NTLM/Kerberos token when challenged by a corp proxy with 407, so
    # `Invoke-WebRequest -Proxy <url>` looks "successful" even though pip
    # can't authenticate. Using HttpClient + UseDefaultCredentials=false
    # + Credentials=null forces an anonymous request, exposing the 407.
    param([string]$ProxyUrl, [string]$TargetUrl, [int]$TimeoutSec = 5)
    $handler = $null
    $client = $null
    try {
        $webProxy = New-Object System.Net.WebProxy($ProxyUrl)
        $webProxy.UseDefaultCredentials = $false
        $webProxy.Credentials = $null
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.Proxy = $webProxy
        $handler.UseProxy = $true
        $handler.UseDefaultCredentials = $false
        $handler.PreAuthenticate = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $response = $client.GetAsync($TargetUrl).Result
        return $response.IsSuccessStatusCode  # 407 → IsSuccessStatusCode = $false
    } catch {
        return $false
    } finally {
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
    }
}

function Get-SystemProxyCandidate {
    # Return the candidate proxy URL (env override → IE registry → $null)
    # WITHOUT gating on a single pypi.org probe. Per-source decisions live
    # in Test-SourceMode below. Previous gating broke the user-reported
    # case where corp-proxy → pypi.org fails but corp-proxy → Tsinghua
    # works: pypi probe failed → candidate dropped → mirror probe ran
    # with no proxy candidate → mirror's via-proxy mode never got tested.
    if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
    if ($env:HTTP_PROXY) { return $env:HTTP_PROXY }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            return "http://$($reg.ProxyServer)"
        }
    } catch {}
    return $null
}

# Back-compat shim: legacy callers still source-call Sync-SystemProxy.
# Behavior changed from "auto-inject after pypi probe" to "informational
# only" — the per-source decisions live in Assert-Network now.
function Sync-SystemProxy {
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
        Write-Host "  Proxy env already set: $env:HTTP_PROXY"
        return
    }
    $candidate = Get-SystemProxyCandidate
    if ($candidate) {
        Write-Host "  System proxy detected: $candidate (will be tested per-source)"
    }
    # Defensively disable .NET DefaultWebProxy so .NET-default Invoke-
    # WebRequest calls don't silently route through the system proxy with
    # SSPI credentials, which would let auth-required corp proxies
    # masquerade as "reachable" during anonymous Test-SourceMode probes.
    try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch {}
}

function Test-UrlReachable {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-SourceMode {
    # Probe a URL twice — first with NO proxy (matches `curl --noproxy '*'`),
    # then with the supplied candidate proxy URL (env override OR the system-
    # proxy URL from Get-SystemProxyCandidate). Returns 'direct' / 'proxy' /
    # 'unreachable' so the caller can decide PIP_INDEX_URL + NO_PROXY in
    # alignment with what pip / huggingface_hub will actually do at install.
    #
    # The CandidateProxy parameter (not env) is what enables the
    # "corp-proxy reaches Tsinghua even though it can't reach pypi" case:
    # Sync-SystemProxy no longer gates the candidate on a single pypi probe,
    # so per-source decisions in Assert-Network always see the candidate.
    param([string]$Url, [int]$TimeoutSec = 5, [string]$CandidateProxy = $null)
    # 1. Try without any proxy at all.
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Proxy = $null
        $req.Method = 'HEAD'
        $req.Timeout = $TimeoutSec * 1000
        $resp = $req.GetResponse()
        $resp.Close()
        return 'direct'
    } catch {}
    # 2. Try via candidate proxy (anonymous — DON'T let .NET auto-fill the
    #    SSPI token, that would mask auth-required corp proxies as reachable).
    $proxyUrl = $CandidateProxy
    if (-not $proxyUrl) {
        # Back-compat: still pick up env if caller didn't supply explicit.
        $proxyUrl = $env:HTTPS_PROXY
        if (-not $proxyUrl) { $proxyUrl = $env:HTTP_PROXY }
    }
    if ($proxyUrl) {
        try {
            $webProxy = New-Object System.Net.WebProxy($proxyUrl)
            $webProxy.UseDefaultCredentials = $false
            $webProxy.Credentials = $null
            $req = [System.Net.HttpWebRequest]::Create($Url)
            $req.Proxy = $webProxy
            $req.Method = 'HEAD'
            $req.Timeout = $TimeoutSec * 1000
            $resp = $req.GetResponse()
            $resp.Close()
            return 'proxy'
        } catch {}
    }
    return 'unreachable'
}

function Write-ProxyGuidance {
    param([string]$Context)
    Write-Host ""
    Write-Host "  WARNING: $Context"
    Write-Host "  当前网络下既不能直连 pypi.org / huggingface.co，也不能访问我们默认尝试的镜像（清华 / hf-mirror）。"
    Write-Host "  你需要在 .env 中（或临时 export 后重试）做下面任一选择："
    Write-Host ""
    Write-Host "  方案 A — 配置一个可用的 HTTP 代理（地址可按 RFC 标准包含认证信息）:"
    Write-Host "    HTTP_PROXY=http://<host>:<port>                 # 无认证代理"
    Write-Host "    HTTP_PROXY=http://<user>:<password>@<host>:<port>   # 带认证的标准代理"
    Write-Host "    HTTPS_PROXY=<同上>"
    Write-Host ""
    Write-Host "  方案 B — 配置当前网络下可达的镜像源（不走代理）:"
    Write-Host "    PIP_INDEX_URL=<可达的 pip 镜像，如 https://pypi.tuna.tsinghua.edu.cn/simple>"
    Write-Host "    HF_ENDPOINT=<可达的 HuggingFace 镜像，如 https://hf-mirror.com>"
    Write-Host ""
    Write-Host "  ⚠ 改完 .env 后需要重启主服务（API），新代理 / 镜像 env 才会注入 install 子进程。"
    Write-Host ""
}

function Add-NoProxyHost {
    param([string]$Host)
    $entries = @()
    if ($env:NO_PROXY) { $entries = @($env:NO_PROXY -split ',') }
    $entries += $Host
    $env:NO_PROXY = ($entries | Where-Object { $_ } | Select-Object -Unique) -join ','
}

function Assert-Network {
    Sync-SystemProxy   # back-compat: informational + clears .NET DefaultWebProxy

    # Get the candidate proxy URL (env first, then registry). This is
    # passed explicitly to every Test-SourceMode call so per-source
    # decisions don't depend on whether env was already set.
    $candidate = Get-SystemProxyCandidate
    $needProxyInjection = $false

    # Probe each candidate source twice (direct + via candidate proxy).
    $pypiMode = Test-SourceMode -Url "https://pypi.org/simple/" -TimeoutSec 5 -CandidateProxy $candidate
    if ($pypiMode -eq 'direct') {
        Write-Host "  PyPI connectivity [OK] (direct)"
        Add-NoProxyHost "pypi.org"
    } elseif ($pypiMode -eq 'proxy') {
        Write-Host "  PyPI connectivity [OK] (via proxy: $candidate)"
        $needProxyInjection = $true
    } else {
        Write-Host "  PyPI unreachable both direct and via proxy — switching to mirror"
        $tsinghuaMode = Test-SourceMode -Url "https://pypi.tuna.tsinghua.edu.cn/simple/" -TimeoutSec 5 -CandidateProxy $candidate
        if ($tsinghuaMode -eq 'direct') {
            Write-Host "  Tsinghua mirror reachable (direct) — pip will bypass proxy"
            $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
            $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
            Add-NoProxyHost "pypi.tuna.tsinghua.edu.cn"
            Add-NoProxyHost "mirrors.tuna.tsinghua.edu.cn"
        } elseif ($tsinghuaMode -eq 'proxy') {
            Write-Host "  Tsinghua mirror reachable (via proxy: $candidate) — pip will route through proxy"
            $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
            $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
            $needProxyInjection = $true
        } else {
            Write-ProxyGuidance -Context "pypi.org 和清华镜像在 direct + via proxy 两种模式下都不可达，pip install 一定会失败。"
        }
    }

    # Same two-mode probe for HuggingFace.
    $hfMode = Test-SourceMode -Url "https://huggingface.co" -TimeoutSec 5 -CandidateProxy $candidate
    if ($hfMode -eq 'direct') {
        Write-Host "  HuggingFace connectivity [OK] (direct)"
        Add-NoProxyHost "huggingface.co"
    } elseif ($hfMode -eq 'proxy') {
        Write-Host "  HuggingFace connectivity [OK] (via proxy: $candidate)"
        $needProxyInjection = $true
    } else {
        $hfMirrorMode = Test-SourceMode -Url "https://hf-mirror.com" -TimeoutSec 5 -CandidateProxy $candidate
        if ($hfMirrorMode -eq 'direct') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (direct)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
            Add-NoProxyHost "hf-mirror.com"
        } elseif ($hfMirrorMode -eq 'proxy') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (via proxy: $candidate)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
            $needProxyInjection = $true
        } else {
            Write-ProxyGuidance -Context "huggingface.co 和 hf-mirror.com 在 direct + via proxy 两种模式下都不可达，模型下载一定会失败。"
        }
    }

    # Only inject HTTP_PROXY / HTTPS_PROXY if at least one source actually
    # needs the candidate proxy to be reachable. This avoids the old bug
    # where injecting the system proxy made pip route everything through
    # an unauthenticated corp proxy that returned 407.
    if ($needProxyInjection -and $candidate -and -not $env:HTTP_PROXY -and -not $env:HTTPS_PROXY) {
        $env:HTTP_PROXY = $candidate
        $env:HTTPS_PROXY = $candidate
        Write-Host "  Injected HTTP_PROXY / HTTPS_PROXY = $candidate (needed for at least one source)"
    }

    # Public fallback when user already has PIP_INDEX_URL set (e.g. an
    # internal corporate mirror). pip honors PIP_EXTRA_INDEX_URL natively;
    # when the primary index doesn't have a package (e.g. internal mirror
    # missing sentence-transformers), pip falls back to extra-index-url.
    # Without this, an internal-only mirror is a dead end for any package
    # the IT team didn't pre-mirror.
    if ($env:PIP_INDEX_URL -and -not $env:PIP_EXTRA_INDEX_URL) {
        if ($pypiMode -eq 'direct' -or $pypiMode -eq 'proxy') {
            $env:PIP_EXTRA_INDEX_URL = 'https://pypi.org/simple'
            Write-Host "  Injected PIP_EXTRA_INDEX_URL = https://pypi.org/simple (public fallback; user already set PIP_INDEX_URL=$env:PIP_INDEX_URL)"
        } else {
            $fbMode = Test-SourceMode -Url 'https://pypi.tuna.tsinghua.edu.cn/simple/' -TimeoutSec 5 -CandidateProxy $candidate
            if ($fbMode -eq 'direct' -or $fbMode -eq 'proxy') {
                $env:PIP_EXTRA_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'
                Write-Host "  Injected PIP_EXTRA_INDEX_URL = Tsinghua mirror (public fallback; user already set PIP_INDEX_URL=$env:PIP_INDEX_URL)"
            }
        }
    }
}
