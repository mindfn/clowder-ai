<#
.SYNOPSIS
  Shared prerequisite check for ML service install scripts on Windows.
.DESCRIPTION
  Provides Resolve-BootstrapPython (finds py/python) and Assert-Python310
  (checks version >= 3.10). Source this at the top of each install script.
#>

function Resolve-BootstrapPython {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return [pscustomobject]@{
            Path = $py.Source
            PrefixArgs = @('-3')
        }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return [pscustomobject]@{
            Path = $python.Source
            PrefixArgs = @()
        }
    }
    Write-Error @"
ERROR: Python 3 not found.

Please install Python 3.10+ from https://www.python.org/downloads/
Make sure to check "Add python.exe to PATH" during installation.
"@
    exit 1
}

function Assert-Python310 {
    param([pscustomobject]$Bootstrap)
    $ver = & $Bootstrap.Path @($Bootstrap.PrefixArgs + @('-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'))
    $parts = $ver.Trim() -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
        Write-Error "ERROR: Python $ver too old, need 3.10+."
        exit 1
    }
    Write-Host "  Python $ver ✓"
}
