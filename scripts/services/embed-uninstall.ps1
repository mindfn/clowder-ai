<#
.SYNOPSIS
  Remove Embedding service virtual environment on Windows.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\embed-venv"

if (-not (Test-Path $VenvDir)) {
    Write-Host "Venv not found: $VenvDir"
    exit 0
}

Write-Host "Removing venv: $VenvDir ..."
Remove-Item -Recurse -Force $VenvDir
Write-Host "Uninstall complete."
