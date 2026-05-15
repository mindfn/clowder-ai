#!/usr/bin/env bash
# scripts/tts-uninstall.sh
# Remove TTS service virtual environment and dependencies.
set -euo pipefail

# Uninstall scripts are spawned by the API without sourcing
# python-resolve.sh, so CAT_CAFE_HOME may not be set in env. Mirror
# the resolver's default (caller env override -> <repoRoot>/.cat-cafe)
# so `set -u` doesn't trip on the unbound variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/tts-venv"
# Legacy path cleanup — see embed-uninstall.sh for rationale.
VENV_DIR_LEGACY="${HOME}/.cat-cafe/tts-venv"

removed=0
if [ -d "$VENV_DIR" ]; then
  echo "删除虚拟环境: $VENV_DIR ..."
  rm -rf "$VENV_DIR"
  removed=1
fi
if [ -d "$VENV_DIR_LEGACY" ] && [ "$VENV_DIR_LEGACY" != "$VENV_DIR" ]; then
  echo "删除遗留虚拟环境（pre-a34ab1f2 路径）: $VENV_DIR_LEGACY ..."
  rm -rf "$VENV_DIR_LEGACY"
  removed=1
fi
if [ "$removed" = "0" ]; then
  echo "虚拟环境不存在: $VENV_DIR (legacy: $VENV_DIR_LEGACY)"
  exit 0
fi
echo "卸载完成。"
