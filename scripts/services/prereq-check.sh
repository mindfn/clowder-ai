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
  # CAT_CAFE_HOME exported by python-resolve.sh — falls back to legacy
  # ${HOME}/.cat-cafe only if the resolver hasn't been sourced yet (e.g.
  # check_disk_space called from a context without check_python3 above it).
  local target_dir="${CAT_CAFE_HOME:-${HOME}/.cat-cafe}"
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
  echo "  当前网络下既不能直连 pypi.org / huggingface.co，也不能访问我们默认尝试的镜像（清华 / hf-mirror）。"
  echo "  你需要在 .env 中（或临时 export 后重试）做下面任一选择："
  echo ""
  echo "  方案 A — 配置一个可用的 HTTP 代理（地址可按 RFC 标准包含认证信息）:"
  echo "    HTTP_PROXY=http://<host>:<port>                  # 无认证代理"
  echo "    HTTP_PROXY=http://<user>:<password>@<host>:<port>    # 带认证的标准代理"
  echo "    HTTPS_PROXY=<同上>"
  echo ""
  echo "  方案 B — 配置当前网络下可达的镜像源（不走代理）:"
  echo "    PIP_INDEX_URL=<可达的 pip 镜像，如 https://pypi.tuna.tsinghua.edu.cn/simple>"
  echo "    HF_ENDPOINT=<可达的 HuggingFace 镜像，如 https://hf-mirror.com>"
  echo ""
  echo "  ⚠ 改完 .env 后需要重启主服务（API），新代理 / 镜像 env 才会注入 install 子进程。"
  echo ""
}

_test_source_mode() {
  # Probe a URL twice — first without any proxy (matches how pip will
  # hit the host once we add it to NO_PROXY), then with the env proxy.
  # Echoes 'direct' / 'proxy' / 'unreachable' so the caller can write
  # PIP_INDEX_URL + NO_PROXY in a way that matches pip's runtime path.
  local url="$1"
  local timeout="${2:-5}"
  if curl -sf --max-time "$timeout" --noproxy '*' "$url" >/dev/null 2>&1; then
    echo "direct"
    return
  fi
  if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}${https_proxy:-}${http_proxy:-}" ]; then
    if curl -sf --max-time "$timeout" "$url" >/dev/null 2>&1; then
      echo "proxy"
      return
    fi
  fi
  echo "unreachable"
}

_add_no_proxy_host() {
  local h="$1"
  if [ -z "${NO_PROXY:-}" ]; then
    export NO_PROXY="$h"
  else
    case ",$NO_PROXY," in
      *",$h,"*) ;;  # already present
      *) export NO_PROXY="${NO_PROXY},$h" ;;
    esac
  fi
}

check_network() {
  normalize_proxy_scheme

  local timeout=5
  if ! command -v curl &>/dev/null; then
    return
  fi

  local pypi_mode
  pypi_mode=$(_test_source_mode "https://pypi.org/simple/" "$timeout")
  case "$pypi_mode" in
    direct)
      echo "  PyPI 连接 ✓ (direct)"
      _add_no_proxy_host "pypi.org"
      ;;
    proxy)
      echo "  PyPI 连接 ✓ (via env proxy)"
      ;;
    unreachable)
      echo "WARNING: 无法连接 PyPI (https://pypi.org)，pip install 可能会失败"
      local tsinghua_mode
      tsinghua_mode=$(_test_source_mode "https://pypi.tuna.tsinghua.edu.cn/simple" "$timeout")
      case "$tsinghua_mode" in
        direct)
          if [ -z "${PIP_INDEX_URL:-}" ]; then
            export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
            echo "  自动启用清华 pip 镜像 (direct, 不走代理): $PIP_INDEX_URL"
          fi
          _add_no_proxy_host "pypi.tuna.tsinghua.edu.cn"
          _add_no_proxy_host "mirrors.tuna.tsinghua.edu.cn"
          ;;
        proxy)
          if [ -z "${PIP_INDEX_URL:-}" ]; then
            export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
            echo "  自动启用清华 pip 镜像 (via env proxy): $PIP_INDEX_URL"
          fi
          # Deliberately NOT adding to NO_PROXY so pip honors HTTP_PROXY.
          ;;
        unreachable)
          _print_proxy_guidance "pypi.org 和清华镜像在 direct + via proxy 两种模式下都不可达。"
          ;;
      esac
      ;;
  esac

  local hf_mode
  hf_mode=$(_test_source_mode "https://huggingface.co" "$timeout")
  case "$hf_mode" in
    direct)
      echo "  HuggingFace 连接 ✓ (direct)"
      _add_no_proxy_host "huggingface.co"
      ;;
    proxy)
      echo "  HuggingFace 连接 ✓ (via env proxy)"
      ;;
    unreachable)
      echo "WARNING: 无法连接 HuggingFace (https://huggingface.co)，模型下载可能会失败"
      local hf_mirror_mode
      hf_mirror_mode=$(_test_source_mode "https://hf-mirror.com" "$timeout")
      case "$hf_mirror_mode" in
        direct)
          if [ -z "${HF_ENDPOINT:-}" ]; then
            export HF_ENDPOINT="https://hf-mirror.com"
            echo "  自动启用 HF 镜像 (direct): $HF_ENDPOINT"
          fi
          _add_no_proxy_host "hf-mirror.com"
          ;;
        proxy)
          if [ -z "${HF_ENDPOINT:-}" ]; then
            export HF_ENDPOINT="https://hf-mirror.com"
            echo "  自动启用 HF 镜像 (via env proxy): $HF_ENDPOINT"
          fi
          ;;
        unreachable)
          _print_proxy_guidance "huggingface.co 和 hf-mirror.com 在 direct + via proxy 两种模式下都不可达。"
          ;;
      esac
      ;;
  esac

  # Public fallback when user already has PIP_INDEX_URL set (e.g. an
  # internal corporate mirror). pip honors PIP_EXTRA_INDEX_URL natively;
  # when the primary index doesn't have a package (e.g. internal mirror
  # missing sentence-transformers), pip falls back to extra-index-url.
  # Without this, an internal-only mirror is a dead end for any package
  # the IT team didn't pre-mirror.
  if [ -n "${PIP_INDEX_URL:-}" ] && [ -z "${PIP_EXTRA_INDEX_URL:-}" ]; then
    if [ "$pypi_mode" = "direct" ] || [ "$pypi_mode" = "proxy" ]; then
      export PIP_EXTRA_INDEX_URL="https://pypi.org/simple"
      echo "  注入 PIP_EXTRA_INDEX_URL=https://pypi.org/simple（公共 fallback，用户已设 PIP_INDEX_URL=$PIP_INDEX_URL）"
    else
      local tsinghua_fb_mode
      tsinghua_fb_mode=$(_test_source_mode "https://pypi.tuna.tsinghua.edu.cn/simple/" "$timeout")
      if [ "$tsinghua_fb_mode" = "direct" ] || [ "$tsinghua_fb_mode" = "proxy" ]; then
        export PIP_EXTRA_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        echo "  注入 PIP_EXTRA_INDEX_URL=清华镜像（公共 fallback，用户已设 PIP_INDEX_URL=$PIP_INDEX_URL）"
      fi
    fi
  fi
}
