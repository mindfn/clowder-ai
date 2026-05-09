<#
.SYNOPSIS
  Install dependencies for TTS service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/tts-venv, installs mlx-audio + misaki[zh] deps,
  and pre-downloads the TTS model from HuggingFace.

  Env vars:
  - TTS_MODEL  (default: mlx-community/Kokoro-82M-bf16)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython

$VenvDir = Join-Path $HOME ".cat-cafe\tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create tts venv" }
}

Write-Host "  Installing dependencies: mlx-audio misaki[zh] fastapi uvicorn httpx[socks] num2words spacy phonemizer huggingface_hub ..."
& $VenvPython -m pip install --quiet -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in tts-venv" }

& $VenvPython -m pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install TTS dependencies" }

$Model = if ($env:TTS_MODEL) { $env:TTS_MODEL } else { "mlx-community/Kokoro-82M-bf16" }
Write-Host "  Pre-downloading model: $Model ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

Write-Host "Installation complete."
