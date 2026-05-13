<#
.SYNOPSIS
  Unified Python 3.12+ interpreter resolver for Windows.
.DESCRIPTION
  Sister of scripts/services/python-resolve.sh — see that file for design
  notes. Key Windows-specific behavior:
    - Require x64 (AMD64) architecture. Native ARM64 Python is rejected
      because aiohttp / PyAV / piper-tts / sentence-transformers have no
      win-arm64 wheels. On ARM64 hardware the AMD64 build runs under the
      built-in Prism emulator.
    - Fallback installer downloads python-3.12.x-amd64.exe from python.org
      and silent-installs to %USERPROFILE%\.cat-cafe\python\
      with PrependPath=0 so the system PATH stays untouched.
.EXAMPLE
  . "$PSScriptRoot\python-resolve.ps1"
  $py = Resolve-Python312
  & $py.Path @($py.PrefixArgs + @('-m', 'venv', "$HOME\.cat-cafe\whisper-venv"))
#>

$script:CatCafeHome = Join-Path $HOME ".cat-cafe"
$script:ProjectPythonDir = Join-Path $script:CatCafeHome "python"

function Test-Python312Candidate {
    param([string]$Path, [string[]]$PrefixArgs)
    try {
        $out = & $Path @($PrefixArgs + @('-c', 'import sys, platform; print(sys.version_info[0], sys.version_info[1], platform.machine(), sep=":")')) 2>$null
        if (-not $out) { return $null }
        $parts = "$out".Trim() -split ':'
        if ($parts.Length -lt 3) { return $null }
        $major = [int]$parts[0]; $minor = [int]$parts[1]; $machine = $parts[2].ToLower()
        if ($major -lt 3) { return $null }
        if ($major -eq 3 -and $minor -lt 12) { return $null }
        # Confirm venv module is usable.
        $vcheck = & $Path @($PrefixArgs + @('-c', 'import venv')) 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        # Reject non-AMD64 architectures: on Windows we always need a binary
        # that pip-installs aiohttp / PyAV / piper-tts. arm64 native fails.
        if ($machine -notin @('amd64', 'x86_64')) { return $null }
        return [pscustomobject]@{
            Path = $Path
            PrefixArgs = $PrefixArgs
            Version = "$major.$minor"
            Machine = $machine
        }
    } catch {
        return $null
    }
}

function Try-SystemPythons {
    $candidates = @(
        @{ Cmd = 'py';      Args = @('-3.13') },
        @{ Cmd = 'py';      Args = @('-3.12') },
        @{ Cmd = 'py';      Args = @('-3') },
        @{ Cmd = 'python';  Args = @() },
        @{ Cmd = 'python3'; Args = @() }
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c.Cmd -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $info = Test-Python312Candidate -Path $cmd.Source -PrefixArgs $c.Args
        if ($info) {
            $info | Add-Member -NotePropertyName Source -NotePropertyValue 'system' -PassThru
            return $info
        }
    }
    return $null
}

function Try-UvPython {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { return $null }
    try {
        $found = (uv python find '>=3.12' 2>$null).Trim()
        if (-not $found -or -not (Test-Path $found)) { return $null }
        $info = Test-Python312Candidate -Path $found -PrefixArgs @()
        if ($info) {
            $info | Add-Member -NotePropertyName Source -NotePropertyValue 'uv' -PassThru
            return $info
        }
    } catch {}
    return $null
}

function Try-ProjectPython {
    $py = Join-Path $script:ProjectPythonDir "python.exe"
    if (-not (Test-Path $py)) { return $null }
    $info = Test-Python312Candidate -Path $py -PrefixArgs @()
    if ($info) {
        $info | Add-Member -NotePropertyName Source -NotePropertyValue 'project' -PassThru
        return $info
    }
    return $null
}

function Install-PythonToProjectDir {
    # Download python-3.12.x-amd64.exe and silent-install to project dir.
    # PrependPath=0 keeps the system PATH untouched; the resolver returns
    # the absolute path to the project-owned python.exe.
    $hasCurl = Get-Command curl.exe -ErrorAction SilentlyContinue
    $hasIwr = $true  # Invoke-WebRequest is always available
    $version = '3.12.7'
    $installerUrl = "https://www.python.org/ftp/python/$version/python-$version-amd64.exe"
    $installerPath = Join-Path $env:TEMP "python-$version-amd64.exe"

    Write-Host "  Downloading Python $version (AMD64) from python.org..."
    try {
        if ($hasCurl) {
            & curl.exe -L --fail -o $installerPath $installerUrl
        } else {
            Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
        }
    } catch {
        Write-Host "  Failed to download Python installer: $($_.Exception.Message)"
        return $false
    }
    if (-not (Test-Path $installerPath)) { return $false }

    if (-not (Test-Path $script:ProjectPythonDir)) {
        New-Item -ItemType Directory -Path $script:ProjectPythonDir -Force | Out-Null
    }

    Write-Host "  Installing Python to $script:ProjectPythonDir (silent, no PATH changes)..."
    # /quiet: no UI; TargetDir: install location; PrependPath=0: don't touch PATH;
    # Include_pip=1: bundle pip; Include_test=0: skip test suite to save space.
    $args = @(
        "/quiet",
        "TargetDir=$script:ProjectPythonDir",
        "PrependPath=0",
        "Include_pip=1",
        "Include_test=0",
        "Include_doc=0",
        "Include_launcher=0",
        "InstallLauncherAllUsers=0"
    )
    $proc = Start-Process -FilePath $installerPath -ArgumentList $args -Wait -PassThru -NoNewWindow
    Remove-Item -Force $installerPath -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Write-Host "  Python installer exited with code $($proc.ExitCode)"
        return $false
    }
    return Test-Path (Join-Path $script:ProjectPythonDir "python.exe")
}

function Resolve-Python312 {
    # 1. System Python (PATH).
    $info = Try-SystemPythons
    if ($info) { return $info }

    # 2. uv (reuse only — never auto-install uv on the user's system).
    $info = Try-UvPython
    if ($info) { return $info }

    # 3. Project-owned Python (already installed before).
    $info = Try-ProjectPython
    if ($info) { return $info }

    # 4. Last resort: install a project-owned Python.
    if (Install-PythonToProjectDir) {
        $info = Try-ProjectPython
        if ($info) { return $info }
    }

    throw @"
Python 3.12+ (AMD64) not found and could not be auto-installed.

Recommendation:
  1. Download "Windows installer (64-bit)" from https://www.python.org/downloads/
     and check "Add python.exe to PATH" during install. Make sure the
     architecture is AMD64 (the 64-bit installer), not ARM64.
  2. Or install uv (https://astral.sh/uv) and run: uv python install 3.12
  3. On Windows, also check that the App Execution Alias for python.exe is
     disabled: Settings > Apps > Advanced app settings > App execution aliases.
"@
}
