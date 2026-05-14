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

function Sync-SystemProxy {
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
        Write-Host "  Proxy env already set: $env:HTTP_PROXY"
        return
    }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            $proxy = "http://$($reg.ProxyServer)"
            # Probe whether the system proxy is actually usable BEFORE we
            # inject it. Corporate proxies often demand NTLM/Kerberos auth
            # that pip / huggingface_hub / Invoke-WebRequest can't perform —
            # in that case the proxy returns 407 (or just times out) and
            # silently injecting it would force every later download through
            # an unauthorized hop. So we test once, then commit.
            $usable = $false
            try {
                $null = Invoke-WebRequest -Uri "https://pypi.org/simple/" -Proxy $proxy -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
                $usable = $true
            } catch {
                $usable = $false
            }
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
    Write-Host "  配好后关闭弹窗再点一次安装，无需重启 API。"
    Write-Host ""
}

function Assert-Network {
    Sync-SystemProxy

    $proxyDetected = [bool]($env:HTTP_PROXY -or $env:HTTPS_PROXY)
    $useMirror = $false
    if (Test-UrlReachable -Url "https://pypi.org/simple/") {
        Write-Host "  PyPI connectivity [OK]"
        if ($proxyDetected) {
            # Invoke-WebRequest passes through proxy but pip often fails with SSL
            # handshake timeouts through the same proxy. Use domestic mirror instead.
            $useMirror = $true
        }
    } else {
        $useMirror = $true
    }
    if ($useMirror) {
        # Verify Tsinghua before switching — internal/PX networks may need a
        # proxy even to reach domestic mirrors. Surface a clear .env hint
        # instead of silently switching to a mirror the user can't reach.
        if (Test-UrlReachable -Url "https://pypi.tuna.tsinghua.edu.cn/simple/") {
            Write-Host "  Using Tsinghua mirror for pip (bypassing proxy for domestic hosts)"
            $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
            $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
            $noProxy = @("pypi.tuna.tsinghua.edu.cn", "hf-mirror.com", "mirrors.tuna.tsinghua.edu.cn")
            if ($env:NO_PROXY) { $noProxy = @($env:NO_PROXY -split ',') + $noProxy }
            $env:NO_PROXY = ($noProxy | Select-Object -Unique) -join ','
        } else {
            Write-ProxyGuidance -Context "pypi.org 和清华镜像都不可达，pip install 一定会失败。"
            # Don't throw — pip might still work if the user has other connectivity.
        }
    }
    if (Test-UrlReachable -Url "https://huggingface.co") {
        Write-Host "  HuggingFace connectivity [OK]"
    } elseif (Test-UrlReachable -Url "https://hf-mirror.com") {
        Write-Host "  HuggingFace unreachable, switching to hf-mirror.com"
        $env:HF_ENDPOINT = "https://hf-mirror.com"
    } else {
        Write-ProxyGuidance -Context "huggingface.co 和 hf-mirror.com 都不可达，模型下载一定会失败。"
    }
}
