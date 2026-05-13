<#
.SYNOPSIS
  Start local embedding server for Cat Cafe on Windows.

.DESCRIPTION
  Launches scripts/embed-api.py from ~/.cat-cafe/embed-venv.
  Dependencies are managed by Console service installer
  (scripts/services/embed-install.ps1); this script will NOT create the
  venv or install packages — if the venv is missing, the user must run
  the installer (from Console settings) first.

  Supported env vars passed through to embed-api.py:
  - EMBED_PORT  (default 9880; overridden by -Port)
  - EMBED_MODEL (model ID)
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
    throw "Embedding venv not found at $VenvDir. Install the Embedding service first via Console settings (or run scripts/services/embed-install.ps1)."
}

& $VenvPython -c "import fastapi, uvicorn, numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Core deps missing in embed-venv. Re-install via Console settings (or run scripts/services/embed-install.ps1)."
}

Write-Host "Starting Embedding server: port=$Port"
& $VenvPython $ApiScript --port $Port
