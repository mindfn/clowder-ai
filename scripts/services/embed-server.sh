#!/usr/bin/env bash
# scripts/services/embed-server.sh
# Start local embedding server for Cat Cafe memory system (F102).
#
# Usage:
#   EMBED_MODEL=jinaai/jina-embeddings-v2-base-zh ./scripts/services/embed-server.sh
#   EMBED_DIM=512 ./scripts/services/embed-server.sh
#
# EMBED_MODEL is REQUIRED — no fallback default. The backend
# (routes/services.ts resolveSelectedModel) is the single source of truth
# for which model to load; a script-level default historically silently
# picked the wrong model on non-mac platforms when the env was unset.
# Prerequisites: run scripts/services/embed-install.sh first.

set -euo pipefail

VENV_DIR="${CAT_CAFE_HOME}/embed-venv"
PORT="${EMBED_PORT:-9880}"
MODEL="${EMBED_MODEL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$MODEL" ]; then
  echo "ERROR: EMBED_MODEL env var required — backend must specify which model to load." >&2
  echo "If you're running this script directly, set EMBED_MODEL first (e.g. EMBED_MODEL=jinaai/jina-embeddings-v2-base-zh)." >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/services/embed-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

echo "Starting Embedding server: model=$MODEL, port=$PORT"
python3 "$SCRIPT_DIR/embed-api.py" --model "$MODEL" --port "$PORT"
