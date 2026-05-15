#!/usr/bin/env bash
# scripts/services/whisper-install.sh
# Install dependencies for Whisper ASR service (venv + mlx-whisper / faster-whisper).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
check_disk_space 4
check_network
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${CAT_CAFE_HOME}/whisper-venv"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  "$PYTHON3" -m venv "$VENV_DIR" || { echo "ERROR: venv 创建失败" >&2; exit 1; }
fi
source "$VENV_DIR/bin/activate"

echo "  升级 pip ..."
pip install --quiet -U pip

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg 未安装，Whisper ASR 需要 ffmpeg。"
  case "$PLATFORM" in
    Darwin) echo "  请运行: brew install ffmpeg" ;;
    Linux)  echo "  请运行: sudo apt install ffmpeg  # 或 dnf install ffmpeg" ;;
  esac
  exit 1
fi

if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  echo "  安装依赖: mlx-whisper fastapi uvicorn python-multipart httpx[socks] 'huggingface_hub[hf_xet]' ..."
  pip install --quiet mlx-whisper fastapi uvicorn python-multipart 'httpx[socks]' 'huggingface_hub[hf_xet]'

  if [ -z "${WHISPER_MODEL:-}" ]; then
    echo "ERROR: WHISPER_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 WHISPER_MODEL=<model-id> bash $0" >&2
    exit 1
  fi
  MODEL="$WHISPER_MODEL"
  echo "  预下载模型: $MODEL ..."
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
else
  echo "  安装依赖: faster-whisper fastapi uvicorn python-multipart httpx[socks] 'huggingface_hub[hf_xet]' ..."
  pip install --quiet faster-whisper fastapi uvicorn python-multipart 'httpx[socks]' 'huggingface_hub[hf_xet]'

  if [ -z "${WHISPER_MODEL:-}" ]; then
    echo "ERROR: WHISPER_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 WHISPER_MODEL=<model-id> bash $0" >&2
    exit 1
  fi
  MODEL="$WHISPER_MODEL"
  echo "  预下载模型: $MODEL ..."
  "$VENV_DIR/bin/python" -c "
import sys
from faster_whisper import WhisperModel
try:
    WhisperModel(sys.argv[1], device='cpu', compute_type='int8')
    print('模型下载完成。')
except Exception as e:
    print(f'ERROR: 模型下载失败: {e}', file=sys.stderr)
    sys.exit(1)
" "$MODEL"
fi
echo "安装完成。"
