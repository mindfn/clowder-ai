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
    Write-Host "  fastembed install failed (py-rust-stemmers needs build tools), creating stub and retrying..."
    # Create a proper stub package so pip sees py-rust-stemmers as already installed
    $sitePackages = Join-Path $VenvDir "Lib\site-packages"
    $stubDir = Join-Path $sitePackages "py_rust_stemmers"
    $distInfo = Join-Path $sitePackages "py_rust_stemmers-0.1.0.dist-info"
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    New-Item -ItemType Directory -Path $distInfo -Force | Out-Null
    $stubCode = "class Stemmer:`n    def __init__(self, *a, **kw): pass`n    def stem_word(self, w): return w`n    def stem_words(self, ws): return list(ws)"
    Set-Content -Path (Join-Path $stubDir "__init__.py") -Value $stubCode
    Set-Content -Path (Join-Path $distInfo "METADATA") -Value "Metadata-Version: 2.1`nName: py-rust-stemmers`nVersion: 0.1.0"
    Set-Content -Path (Join-Path $distInfo "INSTALLER") -Value "pip"
    Set-Content -Path (Join-Path $distInfo "RECORD") -Value ""
    # Now pip will skip py-rust-stemmers (already "installed") and resolve all other deps normally
    & $VenvPython -m pip install --progress-bar on fastembed fastapi uvicorn numpy huggingface_hub
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }
    Write-Host "  Installed fastembed with py-rust-stemmers stub (dense embeddings only)"
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
