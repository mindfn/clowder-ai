<#
.SYNOPSIS
  Install dependencies for Embedding service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/embed-venv, installs sentence-transformers + torch deps,
  and pre-downloads the embedding model from HuggingFace.

  Env vars:
  - EMBED_MODEL  (default: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython

$VenvDir = Join-Path $HOME ".cat-cafe\embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create embed venv" }
}

Write-Host "  Installing dependencies: sentence-transformers torch fastapi uvicorn numpy huggingface_hub ..."
& $VenvPython -m pip install --quiet -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in embed-venv" }

& $VenvPython -m pip install --quiet sentence-transformers torch fastapi uvicorn numpy huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

$Model = if ($env:EMBED_MODEL) { $env:EMBED_MODEL } else { "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ" }
Write-Host "  Pre-downloading model: $Model ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

Write-Host "Installation complete."
