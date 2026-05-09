<#
.SYNOPSIS
  Install dependencies for LLM post-processing service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/llm-venv, installs mlx-vlm + FastAPI deps,
  and pre-downloads the LLM model from HuggingFace.

  Env vars:
  - LLM_POSTPROCESS_MODEL  (default: mlx-community/Qwen3.5-35B-A3B-4bit)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython

$VenvDir = Join-Path $HOME ".cat-cafe\llm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create llm venv" }
}

Write-Host "  Installing dependencies: mlx-vlm fastapi uvicorn pydantic huggingface_hub ..."
& $VenvPython -m pip install --quiet -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in llm-venv" }

& $VenvPython -m pip install --quiet mlx-vlm "httpx[socks]" torchvision fastapi uvicorn pydantic huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install LLM post-processing dependencies" }

$Model = if ($env:LLM_POSTPROCESS_MODEL) { $env:LLM_POSTPROCESS_MODEL } else { "mlx-community/Qwen3.5-35B-A3B-4bit" }
Write-Host "  Pre-downloading model: $Model ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

Write-Host "Installation complete."
