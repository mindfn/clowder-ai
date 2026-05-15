#!/usr/bin/env bash
# scripts/embed-uninstall.sh
# Remove Embedding service virtual environment and dependencies.
set -euo pipefail

# Uninstall scripts are spawned by the API without sourcing
# python-resolve.sh, so CAT_CAFE_HOME may not be set in env. Mirror
# the resolver's default (caller env override -> <repoRoot>/.cat-cafe)
# so `set -u` doesn't trip on the unbound variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/embed-venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "虚拟环境不存在: $VENV_DIR"
  exit 0
fi

echo "删除虚拟环境: $VENV_DIR ..."
rm -rf "$VENV_DIR"
echo "卸载完成。"
