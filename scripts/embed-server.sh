#!/usr/bin/env bash
# scripts/embed-server.sh
# Legacy compatibility wrapper. The canonical embedding server entrypoint is
# scripts/services/embed-server.sh (Console service lifecycle). This wrapper
# delegates so old configs that hardcode `bash scripts/embed-server.sh` still
# work; it does NOT add a model default — services/embed-server.sh requires
# EMBED_MODEL (Console install passes it via buildLifecycleEnv).
#
# Reason for delegation: a previous version of this wrapper omitted --model
# and would crash against embed-api.py --model required=True. Rather than
# duplicate model resolution logic here, we hand off to the single source
# of truth in scripts/services/.
#
# Usage:
#   EMBED_MODEL=mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ \
#     EMBED_PORT=9880 ./scripts/embed-server.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$SCRIPT_DIR/services/embed-server.sh"

if [ ! -f "$CANONICAL" ]; then
  echo "Error: canonical embed-server not found at $CANONICAL" >&2
  echo "       Run scripts/services/embed-install.sh first, or enable" >&2
  echo "       the Embedding service in Console." >&2
  exit 1
fi

echo "[embed-server] legacy wrapper -> delegating to $CANONICAL"
exec bash "$CANONICAL" "$@"
