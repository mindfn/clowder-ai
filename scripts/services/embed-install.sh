#!/usr/bin/env bash
# scripts/services/embed-install.sh
# Install dependencies for Embedding service (venv + mlx-embeddings /
# sentence-transformers). Pure declarative — install-template.sh
# handles the actual pipeline (F198).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_LABEL="Embedding"
VENV_NAME="embed-venv"
DISK_REQUIRED_GB=3
MODEL_ENV_VAR="EMBED_MODEL"
# Darwin arm64: MLX-native primary + sentence-transformers fallback so
# the embed-api.py runtime can pick either backend at startup. Other
# platforms: sentence-transformers + torch (CPU/CUDA).
PIP_DEPS_ARM64="mlx mlx-embeddings sentence-transformers torch fastapi uvicorn numpy httpx[socks] huggingface_hub[hf_xet]"
PIP_DEPS_OTHER="sentence-transformers torch fastapi uvicorn numpy httpx[socks] huggingface_hub[hf_xet]"

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
