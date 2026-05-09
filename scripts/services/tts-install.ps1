<#
.SYNOPSIS
  Install dependencies for TTS service on Windows (edge-tts, cloud-based).
.DESCRIPTION
  Creates ~/.cat-cafe/tts-venv, installs edge-tts (Microsoft cloud TTS).
  No GPU or model download required — edge-tts streams from Microsoft servers.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 1
Assert-Network

$VenvDir = Join-Path $HOME ".cat-cafe\tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create tts venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in tts-venv" }

Write-Host "  Installing dependencies: edge-tts fastapi uvicorn httpx ..."
& $VenvPython -m pip install --progress-bar on edge-tts fastapi uvicorn "httpx[socks]" huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "Failed to install TTS dependencies" }

Write-Host "Installation complete."
