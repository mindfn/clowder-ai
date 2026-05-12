<#
.SYNOPSIS
  Install dependencies for Embedding service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/embed-venv, installs sentence-transformers + torch
  (matching embed-server.ps1 dependency stack).

  Env vars:
  - EMBED_MODEL  (default: BAAI/bge-small-zh-v1.5)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 2
Assert-Network

$VenvDir = Join-Path $HOME ".cat-cafe\embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create embed venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in embed-venv" }

$hasCuda = $false
try {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $null = & nvidia-smi 2>$null
    if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
    $ErrorActionPreference = $prevEAP
} catch {}

$torchIndex = if ($hasCuda) { "https://download.pytorch.org/whl/cu126" } else { "https://download.pytorch.org/whl/cpu" }
$torchLabel = if ($hasCuda) { "CUDA" } else { "CPU" }
Write-Host "  Installing PyTorch ($torchLabel) from $torchIndex ..."
& $VenvPython -m pip install --progress-bar on torch --index-url $torchIndex
if ($LASTEXITCODE -ne 0) { throw "Failed to install PyTorch" }

Write-Host "  Installing dependencies: sentence-transformers fastapi uvicorn numpy huggingface_hub ..."
& $VenvPython -m pip install --progress-bar on sentence-transformers fastapi uvicorn numpy huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

$Model = if ($env:EMBED_MODEL) { $env:EMBED_MODEL } else { "BAAI/bge-small-zh-v1.5" }
Write-Host "  Pre-downloading model: $Model ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model'); print('Model download complete.')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

Write-Host "Installation complete."
