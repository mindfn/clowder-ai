#!/usr/bin/env bash
# scripts/services/tts-install.sh
# Install dependencies for TTS service (venv + mlx-audio / edge-tts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
check_disk_space 2
check_network
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${CAT_CAFE_HOME}/tts-venv"
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
  echo "  安装依赖: mlx-audio + misaki[zh] ..."
  pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer 'huggingface_hub[hf_xet]'

  if [ -z "${TTS_MODEL:-}" ]; then
    echo "ERROR: TTS_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 TTS_MODEL=<model-id> bash $0" >&2
    exit 1
  fi
  echo "  预下载模型: $TTS_MODEL ..."
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
" "$TTS_MODEL"
else
  if [ -z "${TTS_MODEL:-}" ]; then
    echo "ERROR: TTS_MODEL 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 TTS_MODEL=<model-id> bash $0" >&2
    exit 1
  fi

  # Common deps (always installed so users can swap providers later)
  echo "  安装基础依赖: edge-tts fastapi uvicorn httpx[socks] ..."
  pip install --quiet edge-tts fastapi uvicorn 'httpx[socks]' 'huggingface_hub[hf_xet]'

  case "$TTS_MODEL" in
    piper|zh_CN-*|en_US-*|en_GB-*|*-piper)
      VOICE="${TTS_MODEL}"
      [ "$VOICE" = "piper" ] && VOICE="zh_CN-huayan-medium"
      echo "  安装 piper-tts + 下载离线语音模型: $VOICE ..."
      pip install --quiet piper-tts

      PIPER_DIR="${CAT_CAFE_HOME}/piper-models"
      mkdir -p "$PIPER_DIR"

      case "$VOICE" in
        zh_CN-huayan-medium) BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium" ;;
        en_US-amy-medium)    BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium" ;;
        en_US-lessac-medium) BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium" ;;
        en_GB-alan-medium)   BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium" ;;
        *)
          echo "ERROR: 未知的 piper voice: $VOICE。支持: zh_CN-huayan-medium, en_US-amy-medium, en_US-lessac-medium, en_GB-alan-medium" >&2
          exit 1
          ;;
      esac

      if [ ! -f "$PIPER_DIR/${VOICE}.onnx" ]; then
        curl -fL --progress-bar "$BASE/${VOICE}.onnx" -o "$PIPER_DIR/${VOICE}.onnx" \
          || { echo "ERROR: 下载 $VOICE.onnx 失败" >&2; exit 1; }
      fi
      if [ ! -f "$PIPER_DIR/${VOICE}.onnx.json" ]; then
        curl -fL --progress-bar "$BASE/${VOICE}.onnx.json" -o "$PIPER_DIR/${VOICE}.onnx.json" \
          || { echo "ERROR: 下载 $VOICE.onnx.json 失败" >&2; exit 1; }
      fi
      echo "  Piper 语音模型就绪: $PIPER_DIR/${VOICE}.onnx"
      ;;
    *)
      echo "  TTS 后端: $TTS_MODEL（云端服务，无需本地模型下载）"
      ;;
  esac
fi
echo "安装完成。"
