<#
.SYNOPSIS
  Install dependencies for LLM post-processing service on Windows.
.DESCRIPTION
  Creates ~/.cat-cafe/llm-venv, installs transformers + torch.
  Detects NVIDIA GPU for CUDA acceleration.

  Env vars:
  - LLM_POSTPROCESS_MODEL  (default: Qwen/Qwen2.5-3B-Instruct)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 8
Assert-Network

$VenvDir = Join-Path $HOME ".cat-cafe\llm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create llm venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in llm-venv" }

$hasCuda = $false
try {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $null = & nvidia-smi 2>$null
    if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
    $ErrorActionPreference = $prevEAP
} catch {}

if ($hasCuda) {
    Write-Host "  NVIDIA GPU detected, installing CUDA-accelerated torch ..."
    & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cu121
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  CUDA torch failed, falling back to CPU torch"
        & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cpu
    }
} else {
    Write-Host "  No NVIDIA GPU detected, installing CPU torch ..."
    & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cpu
}
if ($LASTEXITCODE -ne 0) { throw "Failed to install torch" }

Write-Host "  Installing dependencies: transformers fastapi uvicorn pydantic ..."
& $VenvPython -m pip install --progress-bar on transformers fastapi uvicorn pydantic huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install LLM dependencies" }

$LlmModel = if ($env:LLM_POSTPROCESS_MODEL) { $env:LLM_POSTPROCESS_MODEL } else { "Qwen/Qwen2.5-3B-Instruct" }
Write-Host "  Pre-downloading model: $LlmModel ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$LlmModel')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $LlmModel" }

Write-Host "Installation complete."
