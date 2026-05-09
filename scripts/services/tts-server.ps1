<#
.SYNOPSIS
  Start local TTS server for Cat Cafe voice output on Windows.

.DESCRIPTION
  Activates ~/.cat-cafe/tts-venv and launches tts-api.py.

  Env vars:
  - TTS_MODEL     (default: mlx-community/Kokoro-82M-bf16)
  - TTS_PORT      (default: 9879; overridden by -Port)
  - TTS_PROVIDER  (default: qwen3-clone)

.PARAMETER Port
  Loopback port for the local TTS HTTP sidecar.
#>

param(
    [int]$Port = 9879
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "tts-api.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error @"
ERROR: Venv not found: $VenvDir
Please run install first: scripts\services\tts-install.ps1
"@
    exit 1
}

$Model = if ($env:TTS_MODEL) { $env:TTS_MODEL } else { "mlx-community/Kokoro-82M-bf16" }
if ($env:TTS_PORT) { $Port = [int]$env:TTS_PORT }
$Provider = if ($env:TTS_PROVIDER) { $env:TTS_PROVIDER } else { "qwen3-clone" }

Write-Host "Starting TTS server: provider=$Provider, model=$Model, port=$Port"
$env:TTS_PROVIDER = $Provider
& $VenvPython $ApiScript --model $Model --port $Port
