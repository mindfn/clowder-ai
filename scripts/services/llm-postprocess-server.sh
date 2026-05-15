#!/usr/bin/env bash
# scripts/services/llm-postprocess-server.sh
# Start local LLM post-processing server for Cat Cafe voice input (MLX backend).
#
# Pipeline position:  Whisper ASR -> **LLM post-edit** -> term dictionary -> filler removal
#
# Usage:
#   ./scripts/services/llm-postprocess-server.sh                                            # default: Qwen3.5-35B-A3B MoE
#   ./scripts/services/llm-postprocess-server.sh mlx-community/Qwen3.5-35B-A3B-4bit        # explicit
#
# Prerequisites: run scripts/services/llm-postprocess-install.sh first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/llm-venv"
MODEL="${LLM_POSTPROCESS_MODEL:-${1:-}}"
if [ -z "$MODEL" ]; then
  echo "ERROR: LLM_POSTPROCESS_MODEL env var (or positional arg) required -- backend specifies model, no fallback default." >&2
  exit 1
fi
PORT="${LLM_POSTPROCESS_PORT:-9878}"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: venv not found: $VENV_DIR"
  echo "Run install first: scripts/services/llm-postprocess-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

python3 "$SCRIPT_DIR/llm-postprocess-api.py" --model "$MODEL" --port "$PORT"
