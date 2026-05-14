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

# Arch check: gate on the *interpreter's* architecture (resolved by
# python-resolve.ps1), not the host OS. On ARM64 Windows the resolver
# downloads an AMD64 Python to ~/.cat-cafe/python/, so $BootstrapPython
# can be AMD64 even when the host OS is ARM64 — in that case transformers
# / tokenizers install fine. Reject only when the interpreter itself is
# native ARM64 (where no upstream wheels exist).
$interpreterMachine = (& $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-c', 'import platform; print(platform.machine())'))).Trim().ToLower()
if ($interpreterMachine -eq 'arm64' -or $interpreterMachine -eq 'aarch64') {
    Write-Error @"
ERROR: LLM 后处理服务暂不支持 ARM64 Python 解释器。

原因: transformers 库依赖 tokenizers/safetensors (Rust 编译)，目前没有 win-arm64 预编译包。
      与 Embedding 不同，LLM 文本生成没有纯 ONNX 的轻量替代方案。

解决方案:
  1. 让 cat-cafe 的 python-resolve 自动安装 AMD64 Python 到 ~/.cat-cafe/python/，
     然后重试（这是 ARM64 Windows 上的标准路径，依靠 Prism emulation 跑 AMD64 wheel）。
  2. 或者手动从 https://www.python.org/downloads/ 下载 "Windows installer (64-bit)"。
  3. 跳过此服务 — LLM 后处理仅用于 ASR 二次校准，不影响语音识别本身。
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
    'transformers', 'fastapi', 'uvicorn', 'pydantic', 'huggingface_hub[hf_xet]')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install LLM dependencies" }

if (-not $env:LLM_POSTPROCESS_MODEL) {
    throw "ERROR: LLM_POSTPROCESS_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 `$env:LLM_POSTPROCESS_MODEL='<model-id>' 后再跑。"
}
$LlmModel = $env:LLM_POSTPROCESS_MODEL
Write-Host "  Pre-downloading model: $LlmModel ..."
& $VenvPython -c "from huggingface_hub import snapshot_download; snapshot_download('$LlmModel')"
if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $LlmModel" }

Write-Host "Installation complete."
