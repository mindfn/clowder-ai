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
    # python.exe exists but Test-Python312Candidate rejected it. Surface
    # the actual interpreter telemetry so the user (and us) can tell whether
    # it's wrong arch, wrong version, or just unable to run at all. This
    # is the *only* place we know a project-owned python.exe is broken —
    # Test-Python312Candidate swallows errors silently so it works in
    # Try-SystemPythons / Try-UvPython without log noise.
    [Console]::Error.WriteLine("  Project Python at $py exists but failed validation:")
    try {
        $pyCode = "import sys, platform; print('version=' + str(sys.version_info[0]) + '.' + str(sys.version_info[1]) + ', machine=' + platform.machine())"
        $diag = & $py -c $pyCode 2>&1
        [Console]::Error.WriteLine("    interpreter reports: $diag")
    } catch {
        [Console]::Error.WriteLine("    interpreter could not be executed: $($_.Exception.Message)")
    }
    try {
        $venvCheck = & $py -c 'import venv' 2>&1
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine("    venv module missing/broken: $venvCheck")
        }
    } catch {}
    return $null
}

function Install-PythonToProjectDir {
    # Wrap download + silent-install in a per-user mutex so concurrent
    # service installs don't race. Use an unprefixed name → equivalent to
    # Local\catCafePythonInstall (session-scoped). Avoid Global\ — that
    # requires SeCreateGlobalPrivilege which standard users lack; trying
    # to create a Global mutex would throw UnauthorizedAccessException
    # that's not in our try-catch path and would unwind to the caller's
    # throw. Multiple service installs only ever race within the same
    # user session, so Local scope is sufficient.
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, "catCafePythonInstall")
    } catch {
        [Console]::Error.WriteLine("  Mutex create failed ($($_.Exception.Message)); proceeding without lock")
        return (Install-PythonToProjectDirInner)
    }
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne([TimeSpan]::FromMinutes(10))
    } catch [System.Threading.AbandonedMutexException] {
        # Previous holder crashed without releasing — we still own it now.
        $acquired = $true
    }
    if (-not $acquired) {
        [Console]::Error.WriteLine("  Python install lock timed out (>10min)")
        $mutex.Dispose()
        return $false
    }
    try {
        # Re-check inside the critical section — another concurrent install
        # might have already finished while we were waiting on the mutex.
        # Use Try-ProjectPython (full validation), not just Test-Path —
        # otherwise a half-installed / wrong-arch / broken python.exe
        # from a prior failed install attempt would make us claim success
        # without verifying the interpreter actually works, and the outer
        # Resolve-Python312 then loops back to Try-ProjectPython which
        # rejects it → throws "Python not found" even though Install said
        # "already present".
        $existingInfo = Try-ProjectPython
        if ($existingInfo) {
            [Console]::Error.WriteLine("  Project Python already present and valid (installed by concurrent install)")
            return $true
        }
        # python.exe might still exist but failed validation. Purge before
        # re-running the silent installer so it starts from a clean state
        # (avoids "TargetDir not empty" rejection and stale registry entries).
        if (Test-Path $script:ProjectPythonDir) {
            [Console]::Error.WriteLine("  Purging stale/invalid Python at $script:ProjectPythonDir before reinstall")
            Remove-Item -Recurse -Force $script:ProjectPythonDir -ErrorAction SilentlyContinue
        }
        return (Install-PythonToProjectDirInner)
    } finally {
        try { $mutex.ReleaseMutex() | Out-Null } catch {}
        $mutex.Dispose()
    }
}

function Sync-ResolverSystemProxy {
    # Mirror of Sync-SystemProxy in prereq-check.ps1 — we duplicate it here
    # rather than source prereq-check.ps1 because python-bootstrap's
    # install-python.ps1 entry only sources python-resolve.ps1 (it's the
    # meta-service entrypoint, doesn't need the rest of prereq-check). Without
    # this, curl.exe below would dial python.org directly, ignoring any
    # Windows system proxy the user has configured — observed: 12 KB/s vs
    # multi-MB/s when proxy is wired up.
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) { return }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            $proxy = "http://$($reg.ProxyServer)"
            $env:HTTP_PROXY = $proxy
            $env:HTTPS_PROXY = $proxy
            [Console]::Error.WriteLine("  System proxy synced for resolver: $proxy")
        }
    } catch {}
}

function Install-PythonToProjectDirInner {
    # Download portable Python from python-build-standalone (astral-sh) —
    # same source as the Unix resolver, hosted on GitHub. We switched away
    # from python.org's silent installer (`python-3.12.x-amd64.exe`) because:
    #   - On restricted networks, python.org TLS frequently breaks under
    #     Windows SChannel ("server closed abruptly (missing close_notify)").
    #     GitHub Releases is more tolerant in the same environments.
    #   - python.org silent installer can pick architecture/redirects we
    #     can't control (observed: ARM64 Python from the AMD64 installer
    #     on Windows ARM64). PBS tarballs are arch-explicit in the URL.
    #   - Same code path on Windows / Linux / macOS — easier to maintain.
    Sync-ResolverSystemProxy
    $hasCurl = Get-Command curl.exe -ErrorAction SilentlyContinue
    $hasTar  = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $hasTar) {
        [Console]::Error.WriteLine("  tar.exe required to extract the portable Python tarball (Windows 10+ ships tar.exe; older Windows is not supported)")
        return $false
    }
    $pbsOwner   = 'astral-sh'
    $pbsRelease = '20260510'
    $pbsVersion = '3.12.13'
    $tarballName = "cpython-$pbsVersion+$pbsRelease-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
    $tarballUrl  = "https://github.com/$pbsOwner/python-build-standalone/releases/download/$pbsRelease/$tarballName"
    $tarballPath = Join-Path $env:TEMP $tarballName
    $extractTmp  = Join-Path $env:TEMP 'cat-cafe-python-extract'

    [Console]::Error.WriteLine("  Downloading portable Python $pbsVersion (AMD64) from python-build-standalone...")
    try {
        if ($hasCurl) {
            # --retry 3: SChannel TLS sometimes drops; auto-retry transient closes.
            # --connect-timeout 30: don't hang forever if proxy is dead.
            # --retry-max-time 600: cap total retry time at 10 min.
            & curl.exe -L --fail --retry 3 --retry-delay 5 --connect-timeout 30 --retry-max-time 600 -o $tarballPath $tarballUrl
            if ($LASTEXITCODE -ne 0) { throw "curl.exe exit $LASTEXITCODE" }
        } else {
            Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath -UseBasicParsing
        }
    } catch {
        [Console]::Error.WriteLine("  Failed to download Python tarball: $($_.Exception.Message)")
        return $false
    }
    if (-not (Test-Path $tarballPath)) {
        [Console]::Error.WriteLine("  Tarball not at expected path: $tarballPath")
        return $false
    }

    if (Test-Path $extractTmp) {
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null

    [Console]::Error.WriteLine("  Extracting Python tarball to $script:ProjectPythonDir ...")
    try {
        & tar.exe -xzf $tarballPath -C $extractTmp
        if ($LASTEXITCODE -ne 0) { throw "tar.exe exit $LASTEXITCODE" }
    } catch {
        [Console]::Error.WriteLine("  Failed to extract Python tarball: $($_.Exception.Message)")
        Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue

    # PBS tarball lays out as `python/{python.exe,Lib,...}` — strip that one
    # level so python.exe lands directly under TargetDir.
    $pythonInTmp = Join-Path $extractTmp 'python'
    if (-not (Test-Path $pythonInTmp)) {
        [Console]::Error.WriteLine("  Unexpected tarball layout: $pythonInTmp not found")
        Show-PythonInstallerDiagnostic -InstallerLog ''
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    if (-not (Test-Path $script:ProjectPythonDir)) {
        New-Item -ItemType Directory -Path $script:ProjectPythonDir -Force | Out-Null
    }
    try {
        Get-ChildItem -Path $pythonInTmp -Force | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $script:ProjectPythonDir -Force
        }
    } catch {
        [Console]::Error.WriteLine("  Failed to relocate extracted Python: $($_.Exception.Message)")
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue

    $expectedPython = Join-Path $script:ProjectPythonDir 'python.exe'
    if (Test-Path $expectedPython) {
        [Console]::Error.WriteLine("  Python $pbsVersion installed to $script:ProjectPythonDir")
        return $true
    }
    [Console]::Error.WriteLine("  Python tarball extracted but $expectedPython is missing.")
    Show-PythonInstallerDiagnostic -InstallerLog ''
    return $false
}

function Show-PythonInstallerDiagnostic {
    param([string]$InstallerLog)
    # Surface what's actually in the target dir so we can tell whether the
    # silent installer redirected (App Execution Alias hijack on Win-ARM64),
    # placed python.exe in a subdirectory, or installed nothing at all.
    if (Test-Path $script:ProjectPythonDir) {
        [Console]::Error.WriteLine("  TargetDir contents ($script:ProjectPythonDir):")
        try {
            Get-ChildItem -Path $script:ProjectPythonDir -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue |
                ForEach-Object { [Console]::Error.WriteLine("    " + $_.FullName) }
        } catch {}
    } else {
        [Console]::Error.WriteLine("  TargetDir does not exist after installer ran: $script:ProjectPythonDir")
    }
    if ($InstallerLog -and (Test-Path $InstallerLog)) {
        [Console]::Error.WriteLine("  Installer log tail ($InstallerLog):")
        try {
            Get-Content -Path $InstallerLog -Tail 40 -ErrorAction SilentlyContinue |
                ForEach-Object { [Console]::Error.WriteLine("    $_") }
        } catch {}
    }
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
