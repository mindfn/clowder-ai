<#
.SYNOPSIS
  Start local Whisper ASR server for Cat Cafe voice input on Windows.

.DESCRIPTION
  Activates ~/.cat-cafe/whisper-venv and launches whisper-api.py.

  Env vars:
  - WHISPER_MODEL  (default: mlx-community/whisper-large-v3-turbo)
  - WHISPER_PORT   (default: 9876; overridden by -Port)

.PARAMETER Port
  Loopback port for the local Whisper HTTP sidecar.
#>

param(
    [int]$Port = 9876
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\whisper-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "whisper-api.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error @"
ERROR: Venv not found: $VenvDir
Please run install first: scripts\services\whisper-install.ps1
"@
    exit 1
}

# Check for ffmpeg
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Error "ERROR: ffmpeg not found. Run: winget install FFmpeg"
    exit 1
}

$Model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "mlx-community/whisper-large-v3-turbo" }
if ($env:WHISPER_PORT) { $Port = [int]$env:WHISPER_PORT }

Write-Host "Starting Whisper ASR server: model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
