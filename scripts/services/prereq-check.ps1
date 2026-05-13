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
    . "$PSScriptRoot\python-resolve.ps1"
    $info = Resolve-Python312   # throws on hard failure
    Write-Host ("  Python {0}: {1} [OK] (arch={2})" -f $info.Source, $info.Path, $info.Machine)
    return [pscustomobject]@{
        Path = $info.Path
        PrefixArgs = $info.PrefixArgs
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
        Write-Host "  Proxy env already set [OK]"
        return
    }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            $proxy = "http://$($reg.ProxyServer)"
            $env:HTTP_PROXY = $proxy
            $env:HTTPS_PROXY = $proxy
            Write-Host "  System proxy detected: $proxy [OK]"
        }
    } catch {}
}

function Assert-Network {
    Sync-SystemProxy

    $proxyDetected = [bool]($env:HTTP_PROXY -or $env:HTTPS_PROXY)
    $useMirror = $false
    try {
        $null = Invoke-WebRequest -Uri "https://pypi.org/simple/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  PyPI connectivity [OK]"
        if ($proxyDetected) {
            # Invoke-WebRequest passes through proxy but pip often fails with SSL
            # handshake timeouts through the same proxy. Use domestic mirror instead.
            $useMirror = $true
        }
    } catch {
        $useMirror = $true
    }
    if ($useMirror) {
        Write-Host "  Using Tsinghua mirror for pip (bypassing proxy for domestic hosts)"
        $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
        $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
        $noProxy = @("pypi.tuna.tsinghua.edu.cn", "hf-mirror.com", "mirrors.tuna.tsinghua.edu.cn")
        if ($env:NO_PROXY) { $noProxy = @($env:NO_PROXY -split ',') + $noProxy }
        $env:NO_PROXY = ($noProxy | Select-Object -Unique) -join ','
    }
    try {
        $null = Invoke-WebRequest -Uri "https://huggingface.co" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  HuggingFace connectivity [OK]"
    } catch {
        Write-Host "  HuggingFace unreachable, switching to hf-mirror.com"
        $env:HF_ENDPOINT = "https://hf-mirror.com"
    }
}
