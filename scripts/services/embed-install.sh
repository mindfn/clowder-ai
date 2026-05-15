#!/usr/bin/env bash
# scripts/services/embed-install.sh
# Install dependencies for Embedding service (venv + mlx-embeddings / sentence-transformers).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
check_disk_space 3
check_network
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${CAT_CAFE_HOME}/embed-venv"
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
  echo "  安装依赖: mlx + mlx-embeddings ..."
  pip install --quiet mlx mlx-embeddings fastapi uvicorn numpy 'httpx[socks]' 'huggingface_hub[hf_xet]'
  echo "  安装 fallback 依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch
else
  echo "  安装依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch fastapi uvicorn numpy 'httpx[socks]' 'huggingface_hub[hf_xet]'
fi

if [ -z "${EMBED_MODEL:-}" ]; then
  echo "ERROR: EMBED_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 EMBED_MODEL=<model-id> bash $0" >&2
  exit 1
fi
MODEL="$EMBED_MODEL"
echo "  预下载模型: $MODEL ..."
# Use the venv Python — $PYTHON3 still points at the bootstrap interpreter
# (system / project-owned), which doesn't see packages we just pip-installed
# into the venv. `source activate` only repointed the shell's `python` alias,
# not the $PYTHON3 variable.
"$VENV_DIR/bin/python" -c "
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from huggingface_hub import snapshot_download
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        snapshot_download(sys.argv[1])
        print('模型下载完成。')
        sys.exit(0)
    except Exception as e:
        msg = f'  下载尝试 {attempt}/{max_attempts} 失败: {e}'
        print(msg, file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  {wait}s 后重试...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: 模型下载失败，已尝试 {max_attempts} 次', file=sys.stderr)
sys.exit(1)
" "$MODEL"
echo "安装完成。"
