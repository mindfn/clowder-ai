#!/usr/bin/env bash
# scripts/services/prereq-check.sh
# Shared prerequisite check for ML service install scripts.
# Source this file at the top of each install script.

check_python3() {
  if ! command -v python3 &>/dev/null; then
    echo "ERROR: Python 3 未找到。"
    echo ""
    echo "请先安装 Python 3.10+："
    case "$(uname -s)" in
      Darwin) echo "  brew install python@3.12" ;;
      Linux)  echo "  sudo apt install python3 python3-venv  # Debian/Ubuntu"
              echo "  sudo dnf install python3              # Fedora/RHEL" ;;
      *)      echo "  请从 https://www.python.org/downloads/ 下载安装" ;;
    esac
    exit 1
  fi

  local py_version
  py_version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  local major minor
  major=$(echo "$py_version" | cut -d. -f1)
  minor=$(echo "$py_version" | cut -d. -f2)
  if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 10 ]; }; then
    echo "ERROR: Python $py_version 版本过低，需要 3.10+。"
    echo "当前版本: $(python3 --version)"
    exit 1
  fi
  echo "  Python $py_version ✓"
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

check_network() {
  local timeout=5
  if command -v curl &>/dev/null; then
    if ! curl -sf --max-time "$timeout" "https://pypi.org/simple/" >/dev/null 2>&1; then
      echo "WARNING: 无法连接 PyPI (https://pypi.org)，pip install 可能会失败"
      echo "  如需使用镜像源，请设置 PIP_INDEX_URL 环境变量"
    else
      echo "  PyPI 连接 ✓"
    fi
    if ! curl -sf --max-time "$timeout" "https://huggingface.co" >/dev/null 2>&1; then
      echo "WARNING: 无法连接 HuggingFace (https://huggingface.co)，模型下载可能会失败"
      echo "  如需使用镜像，请设置 HF_ENDPOINT 环境变量"
    else
      echo "  HuggingFace 连接 ✓"
    fi
  fi
}
