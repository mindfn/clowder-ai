#!/usr/bin/env bash
# scripts/services/tts-install.sh
# Install dependencies for TTS (venv + mlx-audio on Darwin arm64;
# edge-tts cloud / piper offline on other platforms).
# Declarative — install-template.sh handles common pipeline (F198).
# Non-arm64 path skips the generic snapshot_download loader because
# piper voice files don't live on HuggingFace as a HF repo — they're
# raw .onnx / .onnx.json blobs. POST_INSTALL_HOOK_OTHER handles that.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_LABEL="TTS"
VENV_NAME="tts-venv"
DISK_REQUIRED_GB=2
MODEL_ENV_VAR="TTS_MODEL"
PIP_DEPS_ARM64="mlx-audio misaki[zh] fastapi uvicorn httpx[socks] num2words spacy phonemizer huggingface_hub[hf_xet]"
PIP_DEPS_OTHER="edge-tts fastapi uvicorn httpx[socks] huggingface_hub[hf_xet]"
MODEL_LOADER_OTHER="skip"
POST_INSTALL_HOOK_OTHER="tts_install_non_arm64_extras"

# Non-arm64 TTS providers: piper (offline TTS via piper-tts + voice
# files), or cloud (edge-tts — no local model required). Distinguishes
# by TTS_MODEL prefix / value. Called by install-template after the
# generic pip install completes; venv is already activated.
tts_install_non_arm64_extras() {
  case "$TTS_MODEL" in
    piper|zh_CN-*|en_US-*|en_GB-*|*-piper)
      local voice="$TTS_MODEL"
      [ "$voice" = "piper" ] && voice="zh_CN-huayan-medium"
      echo "  安装 piper-tts + 下载离线语音模型: $voice ..."
      pip install --quiet piper-tts

      local piper_dir="${CAT_CAFE_HOME}/piper-models"
      mkdir -p "$piper_dir"

      local base
      case "$voice" in
        zh_CN-huayan-medium) base="https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium" ;;
        en_US-amy-medium)    base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium" ;;
        en_US-lessac-medium) base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium" ;;
        en_GB-alan-medium)   base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium" ;;
        *)
          echo "ERROR: 未知的 piper voice: ${voice}。支持: zh_CN-huayan-medium, en_US-amy-medium, en_US-lessac-medium, en_GB-alan-medium" >&2
          exit 1
          ;;
      esac

      if [ ! -f "$piper_dir/${voice}.onnx" ]; then
        curl -fL --progress-bar "$base/${voice}.onnx" -o "$piper_dir/${voice}.onnx" \
          || { echo "ERROR: 下载 $voice.onnx 失败" >&2; exit 1; }
      fi
      if [ ! -f "$piper_dir/${voice}.onnx.json" ]; then
        curl -fL --progress-bar "$base/${voice}.onnx.json" -o "$piper_dir/${voice}.onnx.json" \
          || { echo "ERROR: 下载 $voice.onnx.json 失败" >&2; exit 1; }
      fi
      echo "  Piper 语音模型就绪: $piper_dir/${voice}.onnx"
      ;;
    *)
      echo "  TTS 后端: ${TTS_MODEL}（云端服务，无需本地模型下载）"
      ;;
  esac
}

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
