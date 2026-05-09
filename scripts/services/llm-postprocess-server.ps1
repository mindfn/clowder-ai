<#
.SYNOPSIS
  Start local LLM post-processing server for Cat Cafe voice input on Windows.

.DESCRIPTION
  Activates ~/.cat-cafe/llm-venv and launches llm-postprocess-api.py.

  Pipeline position:  Whisper ASR -> LLM post-edit -> term dictionary -> filler removal

  Env vars:
  - LLM_POSTPROCESS_MODEL  (default: mlx-community/Qwen3.5-35B-A3B-4bit)
  - LLM_POSTPROCESS_PORT   (default: 9878; overridden by -Port)

.PARAMETER Port
  Loopback port for the local LLM post-processing HTTP sidecar.
#>

param(
    [int]$Port = 9878
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\llm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "llm-postprocess-api.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error @"
ERROR: Venv not found: $VenvDir
Please run install first: scripts\services\llm-postprocess-install.ps1
"@
    exit 1
}

$Model = if ($env:LLM_POSTPROCESS_MODEL) { $env:LLM_POSTPROCESS_MODEL } else { "mlx-community/Qwen3.5-35B-A3B-4bit" }
if ($env:LLM_POSTPROCESS_PORT) { $Port = [int]$env:LLM_POSTPROCESS_PORT }

Write-Host "Starting LLM post-processing server: model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
