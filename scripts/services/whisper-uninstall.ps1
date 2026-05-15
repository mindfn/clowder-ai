<#
.SYNOPSIS
  Remove Whisper ASR service virtual environment on Windows.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

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
