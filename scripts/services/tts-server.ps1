<#
.SYNOPSIS
  Start local TTS server on Windows using edge-tts (cloud-based).
.PARAMETER Port
  Loopback port (default 9879).
#>

param([int]$Port = 9879)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "tts-api.py"

if (-not (Test-Path $VenvPython)) {
    throw "Venv not found: $VenvDir. Run tts-install.ps1 first."
}

$env:TTS_PROVIDER = "edge-tts"
Write-Host "Starting TTS server: provider=edge-tts, port=$Port"
& $VenvPython $ApiScript --port $Port
