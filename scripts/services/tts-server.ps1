<#
.SYNOPSIS
  Start local TTS server on Windows using edge-tts (cloud-based).
.PARAMETER Port
  Loopback port (default 9879).
#>

param([int]$Port = 0)
# API writes user-chosen / auto-allocated port to services.json and passes it
# through TTS_PORT when spawning. Honour env first; fall back to hardcoded
# default only when neither -Port nor $env:TTS_PORT was set.
if ($Port -le 0) {
    if ($env:TTS_PORT) { $Port = [int]$env:TTS_PORT } else { $Port = 9879 }
}

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$VenvDir = Join-Path $HOME ".cat-cafe\tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "tts-api.py"

if (-not (Test-Path $VenvPython)) {
    throw "Venv not found: $VenvDir. Run tts-install.ps1 first."
}

$Model = $env:TTS_MODEL
if (-not $Model) {
    Write-Error "TTS_MODEL env var required - backend specifies model, no fallback default."
    exit 1
}
$Provider = if ($env:TTS_PROVIDER) { $env:TTS_PROVIDER } else {
    switch -Wildcard ($Model) {
        "edge-tts"  { "edge-tts" }
        "sapi"      { "sapi" }
        "piper"     { "piper" }
        "zh_CN-*"   { "piper" }
        "en_US-*"   { "piper" }
        "en_GB-*"   { "piper" }
        default     { "edge-tts" }
    }
}
$env:TTS_PROVIDER = $Provider
Write-Output "Starting TTS server: provider=$Provider, model=$Model, port=$Port"
& $VenvPython $ApiScript --model $Model --port $Port
exit $LASTEXITCODE
