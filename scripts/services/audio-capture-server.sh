#!/usr/bin/env bash
# scripts/services/audio-capture-server.sh
# Start the F195 audio-capture service (meeting audio capture + transcript).
# No model env required -- audio-capture has no ML inference.
# Prerequisites: run scripts/services/audio-capture-install.sh first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
# Expand leading ~ (codex P2 3264135134 -- bash param expansion doesnt
# tilde-expand .env-loaded values).
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/audio-capture-venv"
PORT="${AUDIO_SERVICE_PORT:-9881}"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: venv not found: $VENV_DIR" >&2
  echo "Run install first: scripts/services/audio-capture-install.sh" >&2
  exit 1
fi
source "$VENV_DIR/bin/activate"

# audio-capture runtime impl lives at scripts/meeting-copilot/audio-service.py
# (F195 ownership). Surface a clear error if the file is missing instead of
# spawning an empty venv that binds nothing on PORT.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AUDIO_PY="$REPO_ROOT/scripts/meeting-copilot/audio-service.py"
if [ ! -f "$AUDIO_PY" ]; then
  echo "ERROR: audio-service.py not found at $AUDIO_PY" >&2
  echo "F195 audio-capture runtime is not bundled in this checkout." >&2
  echo "Provide the file or unset AUDIO_SERVICE_ENABLED to skip startup." >&2
  exit 1
fi

echo "Starting Audio Capture server: port=$PORT"
AUDIO_SERVICE_PORT="$PORT" python3 "$AUDIO_PY"
