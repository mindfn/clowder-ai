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
        winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent 2>$null
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

    if (Install-PythonViaWinget) {
        $py2 = Get-Command py -ErrorAction SilentlyContinue
        if ($py2 -and (Test-PythonCandidate -Path $py2.Source -PrefixArgs @('-3'))) {
            Write-Host "  Python installed via winget ✓"
            return [pscustomobject]@{
                Path = $py2.Source
                PrefixArgs = @('-3')
            }
        }
        $python2 = Get-Command python -ErrorAction SilentlyContinue
        if ($python2 -and (Test-PythonCandidate -Path $python2.Source -PrefixArgs @())) {
            Write-Host "  Python installed via winget ✓"
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
    $ver = & $Bootstrap.Path @($Bootstrap.PrefixArgs + @('-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'))
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
    Write-Host "  Python $ver ✓"
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
    Write-Host "  Disk space: ${freeGB}GB available ✓"
}

function Assert-Network {
    $timeout = 5000
    try {
        $r = Invoke-WebRequest -Uri "https://pypi.org/simple/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  PyPI connectivity ✓"
    } catch {
        Write-Warning "Cannot reach PyPI (https://pypi.org) — pip install may fail. Set PIP_INDEX_URL for mirror."
    }
    try {
        $r = Invoke-WebRequest -Uri "https://huggingface.co" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  HuggingFace connectivity ✓"
    } catch {
        Write-Warning "Cannot reach HuggingFace (https://huggingface.co) — model download may fail. Set HF_ENDPOINT for mirror."
    }
}
