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

Write-Host "  Installing dependencies: edge-tts pyttsx3 fastapi uvicorn httpx ..."
$pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
    'edge-tts', 'pyttsx3', 'fastapi', 'uvicorn', 'httpx[socks]', 'huggingface_hub[hf_xet]')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install TTS dependencies" }

$TtsModel = if ($env:TTS_MODEL) { $env:TTS_MODEL } else { "edge-tts" }
$IsPiper = $TtsModel -eq "piper" -or $TtsModel -like "zh_CN-*" -or $TtsModel -like "en_US-*" -or $TtsModel -like "en_GB-*"

if ($IsPiper) {
    $Voice = if ($TtsModel -eq "piper") { "zh_CN-huayan-medium" } else { $TtsModel }
    Write-Host "  Installing piper-tts + downloading voice: $Voice ..."

    $piperArgs = @('-m', 'pip', 'install', '--progress-bar', 'on', 'piper-tts')
    if ($env:PIP_INDEX_URL) { $piperArgs += @('--extra-index-url', 'https://pypi.org/simple/') }
    & $VenvPython @piperArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install piper-tts" }

    $PiperDir = Join-Path $HOME ".cat-cafe\piper-models"
    if (-not (Test-Path $PiperDir)) { New-Item -ItemType Directory -Path $PiperDir | Out-Null }

    $voiceBase = switch ($Voice) {
        "zh_CN-huayan-medium"  { "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium" }
        "en_US-amy-medium"     { "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium" }
        "en_US-lessac-medium"  { "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium" }
        "en_GB-alan-medium"    { "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium" }
        default                { throw "Unknown piper voice: $Voice. Supported: zh_CN-huayan-medium, en_US-amy-medium, en_US-lessac-medium, en_GB-alan-medium" }
    }

    $onnxPath = Join-Path $PiperDir "$Voice.onnx"
    $jsonPath = Join-Path $PiperDir "$Voice.onnx.json"
    if (-not (Test-Path $onnxPath)) {
        Invoke-WebRequest -Uri "$voiceBase/$Voice.onnx" -OutFile $onnxPath -UseBasicParsing
    }
    if (-not (Test-Path $jsonPath)) {
        Invoke-WebRequest -Uri "$voiceBase/$Voice.onnx.json" -OutFile $jsonPath -UseBasicParsing
    }
    Write-Host "  Piper voice model ready: $onnxPath"
}

Write-Host "Installation complete."
