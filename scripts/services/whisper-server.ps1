<#
.SYNOPSIS
  Start local Whisper ASR server on Windows (faster-whisper backend).
.PARAMETER Port
  Loopback port (default 9876).
#>

param([int]$Port = 9876)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\whisper-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "whisper-api.py"

if (-not (Test-Path $VenvPython)) {
    throw "Venv not found: $VenvDir. Run whisper-install.ps1 first."
}

$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegPath) {
    Write-Host "WARNING: ffmpeg not found. Install via: winget install Gyan.FFmpeg"
}

$Model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "large-v3-turbo" }
Write-Host "Starting Whisper server: model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
