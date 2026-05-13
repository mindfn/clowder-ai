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

$isArm64 = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") -or
    ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64)
if ($isArm64) {
    Write-Error @"
ERROR: LLM 后处理服务暂不支持 ARM64 Windows。

原因: transformers 库依赖 tokenizers/safetensors (Rust 编译)，目前没有 ARM64 Windows 预编译包。
      与 Embedding 不同，LLM 文本生成没有纯 ONNX 的轻量替代方案。

影响: 跳过此服务不会影响核心功能。LLM 后处理仅用于 ASR 语音转文字的校准优化
      (修正同音字、标点等)，语音识别本身仍正常工作，只是转写结果不经过二次校准。

解决方案:
  1. 跳过安装 — 推荐，不影响主要功能
  2. 安装 x86 版 Python — Windows ARM 内置 x86 模拟，所有 amd64 包可用
  3. 安装 Visual Studio Build Tools + Rust — 从源码编译 (复杂，不推荐)
"@
    exit 1
}

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
$pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
    'transformers', 'fastapi', 'uvicorn', 'pydantic', 'huggingface_hub')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install LLM dependencies" }

$LlmModel = if ($env:LLM_POSTPROCESS_MODEL) { $env:LLM_POSTPROCESS_MODEL } else { "Qwen/Qwen2.5-3B-Instruct" }
Write-Host "  Pre-downloading model: $LlmModel ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$LlmModel')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $LlmModel" }

Write-Host "Installation complete."
