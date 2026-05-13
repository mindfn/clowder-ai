<#
.SYNOPSIS
  Start local LLM post-processing server on Windows (transformers backend).
.PARAMETER Port
  Loopback port (default 9878).
#>

param([int]$Port = 9878)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\llm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "llm-postprocess-api.py"

if (-not (Test-Path $VenvPython)) {
    throw "Venv not found: $VenvDir. Run llm-postprocess-install.ps1 first."
}

$Model = if ($env:LLM_POSTPROCESS_MODEL) { $env:LLM_POSTPROCESS_MODEL } else { "Qwen/Qwen2.5-3B-Instruct" }
Write-Output "Starting LLM post-process server: model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
exit $LASTEXITCODE
