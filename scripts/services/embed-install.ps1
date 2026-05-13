<#
.SYNOPSIS
  Install dependencies for Embedding service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/embed-venv and installs embedding dependencies.
  ARM64: fastembed + ONNX Runtime (no Rust compilation needed).
  x86/x64: sentence-transformers + torch (full pipeline).

  The embed-api.py auto-detects the available backend at startup.

  Env vars:
  - EMBED_MODEL      (sentence-transformers model, default: BAAI/bge-small-zh-v1.5)
  - EMBED_ONNX_MODEL (fastembed/ONNX model, default: BAAI/bge-small-zh-v1.5)
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

$isArm64 = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") -or
    ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64)

if ($isArm64) {
    Write-Host "  ARM64 detected — using fastembed/ONNX backend (no Rust compilation needed)"

    # Stub py_rust_stemmers before pip install — fastembed's sparse retrieval
    # imports it, but dense embeddings don't use it. Stub prevents ImportError.
    $sitePackages = Join-Path $VenvDir "Lib\site-packages"
    $stubDir = Join-Path $sitePackages "py_rust_stemmers"
    $distInfo = Join-Path $sitePackages "py_rust_stemmers-0.1.0.dist-info"
    if (-not (Test-Path $stubDir)) {
        Write-Host "  Creating py-rust-stemmers stub ..."
        New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
        New-Item -ItemType Directory -Path $distInfo -Force | Out-Null
        Set-Content -Path (Join-Path $stubDir "__init__.py") -Value @"
class Stemmer:
    def __init__(self, *a, **kw): pass
    def stem_word(self, w): return w
    def stem_words(self, ws): return list(ws)
"@
        Set-Content -Path (Join-Path $distInfo "METADATA") -Value "Metadata-Version: 2.1`nName: py-rust-stemmers`nVersion: 0.1.0"
        Set-Content -Path (Join-Path $distInfo "INSTALLER") -Value "pip"
        Set-Content -Path (Join-Path $distInfo "RECORD") -Value ""
    }

    Write-Host "  Installing dependencies: fastembed onnxruntime fastapi uvicorn numpy huggingface_hub ..."
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'fastembed', 'onnxruntime', 'fastapi', 'uvicorn', 'numpy', 'huggingface_hub')
    if ($env:PIP_INDEX_URL) {
        $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
    }
    & $VenvPython @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

    $Model = if ($env:EMBED_ONNX_MODEL) { $env:EMBED_ONNX_MODEL } else { "BAAI/bge-small-zh-v1.5" }
    Write-Host "  Pre-downloading ONNX model: $Model ..."
    & $VenvPython -c "from fastembed import TextEmbedding; TextEmbedding(model_name='$Model'); print('Model download complete.')"
    if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

} else {
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
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'sentence-transformers', 'fastapi', 'uvicorn', 'numpy', 'huggingface_hub')
    if ($env:PIP_INDEX_URL) {
        $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
    }
    & $VenvPython @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

    $Model = if ($env:EMBED_MODEL) { $env:EMBED_MODEL } else { "BAAI/bge-small-zh-v1.5" }
    Write-Host "  Pre-downloading model: $Model ..."
    & $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model'); print('Model download complete.')"
    if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }
}

Write-Host "Installation complete."
