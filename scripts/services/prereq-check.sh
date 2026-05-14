#!/usr/bin/env bash
# scripts/services/prereq-check.sh
# Shared prerequisite check for ML service install scripts.
# Source this file at the top of each install script.

PYTHON3=""
# Delegate to the shared resolver (python-resolve.sh) so all service install
# scripts pick interpreters the same way: prefer system Python 3.12+, then
# reuse uv / pyenv / brew if the user already has them, finally fall back
# to a project-owned interpreter under ~/.cat-cafe/python/. We never
# auto-install uv / pyenv on the user's system; that's their choice.
check_python3() {
  local resolver_dir
  resolver_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=./python-resolve.sh
  . "$resolver_dir/python-resolve.sh"
  if ! resolve_python_312; then
    exit 1
  fi
  PYTHON3="$RESOLVED_PYTHON"
  export PYTHON3 RESOLVED_PYTHON RESOLVED_PYTHON_SOURCE RESOLVED_PYTHON_ARCH
  echo "  Python ${RESOLVED_PYTHON_SOURCE}: $RESOLVED_PYTHON ✓ (arch=$RESOLVED_PYTHON_ARCH)"
}

check_disk_space() {
  local required_gb="${1:-2}"
  local target_dir="${HOME}/.cat-cafe"
  mkdir -p "$target_dir" 2>/dev/null || true
  local avail_kb
  if [ "$(uname -s)" = "Darwin" ]; then
    avail_kb=$(df -k "$target_dir" | tail -1 | awk '{print $4}')
  else
    avail_kb=$(df -k "$target_dir" | tail -1 | awk '{print $4}')
  fi
  local avail_gb=$((avail_kb / 1048576))
  if [ "$avail_gb" -lt "$required_gb" ]; then
    echo "ERROR: 磁盘空间不足。需要 ${required_gb}GB，当前可用 ${avail_gb}GB (${target_dir})"
    exit 1
  fi
  echo "  磁盘空间: ${avail_gb}GB 可用 ✓"
}

normalize_proxy_scheme() {
  # User VPN clients (clash / v2ray etc.) commonly emit ALL_PROXY=socks://...
  # but httpx / huggingface_hub / requests reject that scheme — they want
  # socks5:// (or socks5h://). Auto-rewrite so the user's VPN env "just
  # works" instead of crashing model preload with "Unknown scheme for
  # proxy URL". Also handles http:// proxies that some clients write as
  # plain host:port.
  local var val
  for var in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    val="${!var:-}"
    [ -z "$val" ] && continue
    case "$val" in
      socks://*)
        export "$var=socks5${val#socks}"
        echo "  Normalized $var: socks:// → socks5://"
        ;;
    esac
  done
}

check_network() {
  normalize_proxy_scheme

  local timeout=5
  if command -v curl &>/dev/null; then
    if ! curl -sf --max-time "$timeout" "https://pypi.org/simple/" >/dev/null 2>&1; then
      echo "WARNING: 无法连接 PyPI (https://pypi.org)，pip install 可能会失败"
      echo "  如需使用镜像源，请设置 PIP_INDEX_URL 环境变量"
      # Auto-pick a domestic mirror if user hasn't set one. PIP_INDEX_URL
      # takes precedence over pypi.org but only if we actually export it.
      if [ -z "${PIP_INDEX_URL:-}" ]; then
        export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        echo "  自动启用清华 pip 镜像: $PIP_INDEX_URL"
      fi
    else
      echo "  PyPI 连接 ✓"
    fi
    if ! curl -sf --max-time "$timeout" "https://huggingface.co" >/dev/null 2>&1; then
      echo "WARNING: 无法连接 HuggingFace (https://huggingface.co)，模型下载可能会失败"
      echo "  如需使用镜像，请设置 HF_ENDPOINT 环境变量"
      if [ -z "${HF_ENDPOINT:-}" ]; then
        export HF_ENDPOINT="https://hf-mirror.com"
        echo "  自动启用 HF 镜像: $HF_ENDPOINT"
      fi
    else
      echo "  HuggingFace 连接 ✓"
    fi
  fi
}
