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
    $targetDir = Join-Path $HOME ".cat-cafe"
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

function Sync-SystemProxy {
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
        Write-Host "  Proxy env already set: $env:HTTP_PROXY"
        return
    }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            $proxy = "http://$($reg.ProxyServer)"
            # Probe with NO credentials — see Test-ProxyAnonymous for why.
            # A corporate proxy that needs NTLM auth will return 407 here
            # (pip will see the same 407), so we'll skip injection.
            $usable = Test-ProxyAnonymous -ProxyUrl $proxy -TargetUrl "https://pypi.org/simple/" -TimeoutSec 5
            if ($usable) {
                $env:HTTP_PROXY = $proxy
                $env:HTTPS_PROXY = $proxy
                Write-Host "  System proxy detected and reachable: $proxy [OK]"
            } else {
                Write-Host "  System proxy detected but unreachable / auth-required: $proxy"
                Write-Host "  (Skipping — will try direct connection + reachable mirrors instead.)"
                Write-Host "  (If all paths fail, see the WARNING below to configure a usable proxy or mirror.)"
                # Also keep Invoke-WebRequest from silently re-routing through
                # this dead proxy via .NET DefaultWebProxy (which would defeat
                # the direct connection attempt in Assert-Network).
                try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch {}
            }
        }
    } catch {}
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
    # Probe a URL twice — first with NO proxy (the way pip will hit the
    # host once we add it to NO_PROXY), then with the env proxy if one
    # is set. Returns 'direct' / 'proxy' / 'unreachable' so caller can
    # configure PIP_INDEX_URL + NO_PROXY in a way that matches what
    # pip / huggingface_hub will actually do at install time.
    #
    # Background: the old prereq-check probed candidate mirrors with
    # IWR's .NET-default proxy (the registry system proxy). If the
    # corp proxy could reach Tsinghua, we declared "Tsinghua reachable"
    # and added it to NO_PROXY — but then pip ignored the proxy for
    # Tsinghua because of NO_PROXY and the host was actually unreachable
    # without the proxy. probe-vs-runtime mismatch.
    param([string]$Url, [int]$TimeoutSec = 5)
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
    # 2. If user env has a proxy, try via that proxy.
    $proxyUrl = $env:HTTPS_PROXY
    if (-not $proxyUrl) { $proxyUrl = $env:HTTP_PROXY }
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
    Sync-SystemProxy

    # Probe each candidate source twice (direct + via env proxy) so the
    # mode we record for the source matches what pip/huggingface_hub
    # will actually do at install time. See Test-SourceMode comment.
    $pypiMode = Test-SourceMode -Url "https://pypi.org/simple/" -TimeoutSec 5
    if ($pypiMode -eq 'direct') {
        Write-Host "  PyPI connectivity [OK] (direct)"
        # pip will reach pypi.org without proxy — make sure proxy env, if any,
        # bypasses pypi.org so we don't accidentally route through the proxy.
        Add-NoProxyHost "pypi.org"
    } elseif ($pypiMode -eq 'proxy') {
        Write-Host "  PyPI connectivity [OK] (via env proxy)"
        # Leave HTTP_PROXY in place; pip will pick it up.
    } else {
        Write-Host "  PyPI unreachable both direct and via proxy — switching to mirror"
        $tsinghuaMode = Test-SourceMode -Url "https://pypi.tuna.tsinghua.edu.cn/simple/" -TimeoutSec 5
        if ($tsinghuaMode -eq 'direct') {
            Write-Host "  Tsinghua mirror reachable (direct) — pip will bypass proxy"
            $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
            $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
            Add-NoProxyHost "pypi.tuna.tsinghua.edu.cn"
            Add-NoProxyHost "mirrors.tuna.tsinghua.edu.cn"
        } elseif ($tsinghuaMode -eq 'proxy') {
            Write-Host "  Tsinghua mirror reachable (via env proxy) — pip will route through proxy"
            $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
            $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
            # Deliberately NOT adding to NO_PROXY so pip honors HTTP_PROXY.
        } else {
            Write-ProxyGuidance -Context "pypi.org 和清华镜像在 direct + via proxy 两种模式下都不可达，pip install 一定会失败。"
        }
    }

    # Same two-mode probe for HuggingFace.
    $hfMode = Test-SourceMode -Url "https://huggingface.co" -TimeoutSec 5
    if ($hfMode -eq 'direct') {
        Write-Host "  HuggingFace connectivity [OK] (direct)"
        Add-NoProxyHost "huggingface.co"
    } elseif ($hfMode -eq 'proxy') {
        Write-Host "  HuggingFace connectivity [OK] (via env proxy)"
    } else {
        $hfMirrorMode = Test-SourceMode -Url "https://hf-mirror.com" -TimeoutSec 5
        if ($hfMirrorMode -eq 'direct') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (direct)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
            Add-NoProxyHost "hf-mirror.com"
        } elseif ($hfMirrorMode -eq 'proxy') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (via env proxy)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
        } else {
            Write-ProxyGuidance -Context "huggingface.co 和 hf-mirror.com 在 direct + via proxy 两种模式下都不可达，模型下载一定会失败。"
        }
    }
}
