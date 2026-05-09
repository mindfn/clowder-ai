<#
.SYNOPSIS
  Install dependencies for Embedding service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/embed-venv, installs fastembed (ONNX Runtime based,
  lightweight alternative to torch+sentence-transformers for Windows).

  Env vars:
  - EMBED_ONNX_MODEL  (default: BAAI/bge-small-zh-v1.5)
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

Write-Host "  Installing dependencies: fastembed fastapi uvicorn numpy huggingface_hub ..."
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& $VenvPython -m pip install --progress-bar on fastembed fastapi uvicorn numpy huggingface_hub 2>&1
$feResult = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

if ($feResult -ne 0) {
    Write-Host "  fastembed full install failed (missing build tools?), installing without source builds..."
    & $VenvPython -m pip install --progress-bar on onnxruntime tokenizers numpy tqdm requests huggingface_hub Pillow mmh3 loguru pydantic typer fastapi uvicorn
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding core dependencies" }
    & $VenvPython -m pip install --progress-bar on --no-deps fastembed
    if ($LASTEXITCODE -ne 0) { throw "Failed to install fastembed" }
    # Create stub for py-rust-stemmers (only used for sparse retrieval, not dense embeddings)
    $stubDir = Join-Path $VenvDir "Lib\site-packages\py_rust_stemmers"
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    $stubCode = "class Stemmer:`n    def __init__(self, *a, **kw): pass`n    def stem_word(self, w): return w`n    def stem_words(self, ws): return list(ws)"
    Set-Content -Path (Join-Path $stubDir "__init__.py") -Value $stubCode
    Write-Host "  Installed fastembed without py-rust-stemmers (dense embeddings only)"
}

$hasCuda = $false
try {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $null = & nvidia-smi 2>$null
    if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
    $ErrorActionPreference = $prevEAP
} catch {}

if ($hasCuda) {
    Write-Host "  NVIDIA GPU detected, upgrading to GPU-accelerated ONNX Runtime ..."
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $VenvPython -m pip install --progress-bar on onnxruntime-gpu
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  GPU ONNX Runtime install failed, using CPU"
    }
} else {
    Write-Host "  No NVIDIA GPU detected, using CPU inference"
}

$OnnxModel = if ($env:EMBED_ONNX_MODEL) { $env:EMBED_ONNX_MODEL } else { "BAAI/bge-small-zh-v1.5" }
Write-Host "  Pre-downloading ONNX model: $OnnxModel ..."
& $VenvPython -c "from fastembed import TextEmbedding; TextEmbedding(model_name='$OnnxModel')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $OnnxModel" }

Write-Host "Installation complete."
