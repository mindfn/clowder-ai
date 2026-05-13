<#
.SYNOPSIS
  Start local embedding server for Cat Cafe on Windows.

.DESCRIPTION
  Launches embed-api.py from ~/.cat-cafe/embed-venv.
  Dependencies are managed by embed-install.ps1.
  embed-api.py auto-detects backend: MLX → fastembed/ONNX → sentence-transformers.

  Env vars passed through to embed-api.py:
  - EMBED_PORT  (default 9880; overridden by -Port)
  - EMBED_MODEL / EMBED_ONNX_MODEL (model ID)
  - EMBED_DIM   (MRL-truncated output dimension)

.PARAMETER Port
  Loopback port for the local embedding HTTP sidecar.
#>

param(
    [int]$Port = 9880
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "embed-api.py"

if (-not (Test-Path $VenvPython)) {
    throw "Embedding venv not found. Run embed-install.ps1 first."
}

& $VenvPython -c "import fastapi, uvicorn, numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Core deps missing in embed-venv. Run embed-install.ps1 first."
}

$Model = if ($env:EMBED_MODEL) { $env:EMBED_MODEL } else { "BAAI/bge-base-zh-v1.5" }
Write-Output "Starting Embedding server: model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
exit $LASTEXITCODE
