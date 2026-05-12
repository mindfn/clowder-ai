<#
.SYNOPSIS
  Shared prerequisite check for ML service install scripts on Windows.
.DESCRIPTION
  Provides Resolve-BootstrapPython (finds py/python) and Assert-Python310
  (checks version >= 3.10). Source this at the top of each install script.
#>

function Test-PythonCandidate {
    param([string]$Path, [string[]]$PrefixArgs)
    try {
        $out = & $Path @($PrefixArgs + @('--version')) 2>&1
        $text = "$out"
        if ($text -match 'Python (\d+\.\d+)') { return $true }
    } catch {}
    return $false
}

function Install-PythonViaWinget {
    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
    if (-not $hasWinget) { return $false }
    Write-Host "  Attempting Python install via winget..."
    try {
        $null = winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        return $true
    } catch {
        return $false
    }
}

function Resolve-BootstrapPython {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py -and (Test-PythonCandidate -Path $py.Source -PrefixArgs @('-3'))) {
        return [pscustomobject]@{
            Path = $py.Source
            PrefixArgs = @('-3')
        }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python -and (Test-PythonCandidate -Path $python.Source -PrefixArgs @())) {
        return [pscustomobject]@{
            Path = $python.Source
            PrefixArgs = @()
        }
    }

    $wingetOk = Install-PythonViaWinget
    if ($wingetOk) {
        $py2 = Get-Command py -ErrorAction SilentlyContinue
        if ($py2 -and (Test-PythonCandidate -Path $py2.Source -PrefixArgs @('-3'))) {
            Write-Host "  Python installed via winget [OK]"
            return [pscustomobject]@{
                Path = $py2.Source
                PrefixArgs = @('-3')
            }
        }
        $python2 = Get-Command python -ErrorAction SilentlyContinue
        if ($python2 -and (Test-PythonCandidate -Path $python2.Source -PrefixArgs @())) {
            Write-Host "  Python installed via winget [OK]"
            return [pscustomobject]@{
                Path = $python2.Source
                PrefixArgs = @()
            }
        }
    }

    Write-Error @"
ERROR: Python 3 not found.

Please install Python 3.10+ from https://www.python.org/downloads/
Make sure to check "Add python.exe to PATH" during installation.
On Windows, disable the App Execution Alias for python.exe in:
  Settings > Apps > Advanced app settings > App execution aliases
"@
    exit 1
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
