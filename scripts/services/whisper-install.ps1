<#
.SYNOPSIS
  Install dependencies for Whisper ASR service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/whisper-venv, installs mlx-whisper + FastAPI deps,
  and pre-downloads the Whisper model from HuggingFace.

  Env vars:
  - WHISPER_MODEL  (default: mlx-community/whisper-large-v3-turbo)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython

$VenvDir = Join-Path $HOME ".cat-cafe\whisper-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create whisper venv" }
}

# Check for ffmpeg
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Error @"
ERROR: ffmpeg not found. Whisper ASR requires ffmpeg.

Please install ffmpeg:
  winget install FFmpeg
  # or download from https://ffmpeg.org/download.html and add to PATH
"@
    exit 1
}

Write-Host "  Installing dependencies: mlx-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub ..."
& $VenvPython -m pip install --quiet -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in whisper-venv" }

& $VenvPython -m pip install --quiet mlx-whisper fastapi uvicorn python-multipart 'httpx[socks]' huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install whisper dependencies" }

$Model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "mlx-community/whisper-large-v3-turbo" }
Write-Host "  Pre-downloading model: $Model ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$Model')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $Model" }

Write-Host "Installation complete."
