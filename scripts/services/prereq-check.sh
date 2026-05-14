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

_print_proxy_guidance() {
  local context="$1"
  echo ""
  echo "  WARNING: $context"
  echo "  既无法直连 pypi.org / huggingface.co，也无法访问国内镜像（清华 / hf-mirror）。"
  echo "  通常这是内网环境需要 HTTP 代理。请在 .env 中设置（或临时 export 后重试）:"
  echo "    HTTP_PROXY=http://<host>:<port>"
  echo "    HTTPS_PROXY=http://<host>:<port>"
  echo "  PX / cntlm 这类内网认证代理一般是 http://127.0.0.1:3128，Clash 一般是 http://127.0.0.1:7897"
  echo "  配好后关闭弹窗再点一次安装，无需重启 API。"
  echo ""
}

check_network() {
  normalize_proxy_scheme

  local timeout=5
  if ! command -v curl &>/dev/null; then
    return
  fi

  if curl -sf --max-time "$timeout" "https://pypi.org/simple/" >/dev/null 2>&1; then
    echo "  PyPI 连接 ✓"
  else
    echo "WARNING: 无法连接 PyPI (https://pypi.org)，pip install 可能会失败"
    # Verify Tsinghua reachability before switching — internal/PX networks
    # may need a proxy even for domestic mirrors. Surface a clear .env hint
    # instead of silently switching to a mirror the user can't reach.
    if [ -z "${PIP_INDEX_URL:-}" ]; then
      if curl -sf --max-time "$timeout" "https://pypi.tuna.tsinghua.edu.cn/simple/" >/dev/null 2>&1; then
        export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        echo "  自动启用清华 pip 镜像: $PIP_INDEX_URL"
      else
        _print_proxy_guidance "pypi.org 和清华镜像都不可达，pip install 一定会失败。"
      fi
    else
      echo "  已设 PIP_INDEX_URL=$PIP_INDEX_URL"
    fi
  fi

  if curl -sf --max-time "$timeout" "https://huggingface.co" >/dev/null 2>&1; then
    echo "  HuggingFace 连接 ✓"
  else
    echo "WARNING: 无法连接 HuggingFace (https://huggingface.co)，模型下载可能会失败"
    if [ -z "${HF_ENDPOINT:-}" ]; then
      if curl -sf --max-time "$timeout" "https://hf-mirror.com" >/dev/null 2>&1; then
        export HF_ENDPOINT="https://hf-mirror.com"
        echo "  自动启用 HF 镜像: $HF_ENDPOINT"
      else
        _print_proxy_guidance "huggingface.co 和 hf-mirror.com 都不可达，模型下载一定会失败。"
      fi
    else
      echo "  已设 HF_ENDPOINT=$HF_ENDPOINT"
    fi
  fi
}
