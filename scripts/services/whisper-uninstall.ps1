<#
.SYNOPSIS
  Remove Whisper ASR service virtual environment on Windows.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Uninstall scripts are spawned by the API without sourcing
# python-resolve.ps1, so $env:CAT_CAFE_HOME may not be set. Mirror the
# resolver's default (caller env override -> <repoRoot>/.cat-cafe) so
# Join-Path doesn't receive $null.
if (-not $env:CAT_CAFE_HOME) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $env:CAT_CAFE_HOME = Join-Path $repoRoot '.cat-cafe'
}

$VenvDir = Join-Path $env:CAT_CAFE_HOME "whisper-venv"

if (-not (Test-Path $VenvDir)) {
    Write-Host "Venv not found: $VenvDir"
    exit 0
}

Get-Process python* -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$VenvDir*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "Removing venv: $VenvDir ..."
Remove-Item -Recurse -Force $VenvDir -ErrorAction SilentlyContinue
if (Test-Path $VenvDir) {
    Start-Sleep -Seconds 2
    cmd /c "rmdir /s /q `"$VenvDir`""
    if (Test-Path $VenvDir) { throw "Failed to remove $VenvDir — files locked by another process" }
}
Write-Host "Uninstall complete."
