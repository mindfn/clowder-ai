#!/usr/bin/env bash
# scripts/services/llm-postprocess-install.sh
# Install dependencies for LLM post-processing service (venv + mlx-vlm / transformers).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
check_disk_space 25
check_network
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${HOME}/.cat-cafe/llm-venv"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  "$PYTHON3" -m venv "$VENV_DIR" || { echo "ERROR: venv 创建失败" >&2; exit 1; }
fi
source "$VENV_DIR/bin/activate"

echo "  升级 pip ..."
pip install --quiet -U pip

if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  echo "  安装依赖: mlx-vlm fastapi uvicorn pydantic ..."
  pip install --quiet mlx-vlm "httpx[socks]" torchvision fastapi uvicorn pydantic 'huggingface_hub[hf_xet]'

  MODEL="${LLM_POSTPROCESS_MODEL:-mlx-community/Qwen3.5-35B-A3B-4bit}"
else
  echo "  安装依赖: transformers torch fastapi uvicorn pydantic ..."
  pip install --quiet transformers torch fastapi uvicorn pydantic 'huggingface_hub[hf_xet]'

  MODEL="${LLM_POSTPROCESS_MODEL:-Qwen/Qwen2.5-3B-Instruct}"
fi

echo "  预下载模型: $MODEL ..."
# Use the venv Python — $PYTHON3 still points at the bootstrap interpreter
# (system / project-owned). pip install put huggingface_hub in the venv.
"$VENV_DIR/bin/python" -c "
import sys
from huggingface_hub import snapshot_download
try:
    snapshot_download(sys.argv[1])
    print('模型下载完成。')
except Exception as e:
    print(f'ERROR: 模型下载失败: {e}', file=sys.stderr)
    sys.exit(1)
" "$MODEL"
echo "安装完成。"
