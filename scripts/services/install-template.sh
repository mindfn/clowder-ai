#!/usr/bin/env bash
# scripts/services/install-template.sh
#
# Unified install pipeline for ML sidecar services. Per-service install
# scripts declare their differences as environment variables, then source
# this template and call `install_service_main`. Handles everything
# common: prereq check, venv creation, pip install (with retry policy
# inherited from pip itself), model preload with explicit retry +
# extended HF timeout, output logging.
#
# Why: PR #674 had 4 install scripts (~70-100 lines each) that were
# ~85% duplicate. Each bug fix had to land in 4 places, and one
# inconsistency (e.g. retry policy in 3 of 4) caused real user-visible
# bugs ("embedding installs fine but whisper fails on same machine").
# F198 collapses the duplication so one pipeline change = all services
# get it.
#
# CONTRACT (caller exports BEFORE sourcing):
#
#   SERVICE_LABEL          (required) — human label for log lines.
#   VENV_NAME              (required) — venv dir name under
#                                       $CAT_CAFE_HOME (e.g.
#                                       "whisper-venv").
#   DISK_REQUIRED_GB       (required) — int.
#   MODEL_ENV_VAR          (required) — name of the env var that
#                                       holds the model id (e.g.
#                                       "WHISPER_MODEL"). Template
#                                       reads ${!MODEL_ENV_VAR} —
#                                       fails fast if unset.
#   PIP_DEPS_ARM64         (required) — pip deps for Darwin arm64,
#                                       space-separated. Pass empty
#                                       string if path unused.
#   PIP_DEPS_OTHER         (required) — pip deps for non-arm64 path.
#
# OPTIONAL inputs:
#
#   PRE_CHECK_FFMPEG=1            — require ffmpeg on PATH before
#                                   touching venv (whisper).
#
#   MODEL_LOADER_ARM64="snapshot"    — model loader strategy for arm64;
#   MODEL_LOADER_OTHER="snapshot"      one of:
#                                       "snapshot"        snapshot_download
#                                       "faster_whisper"  WhisperModel
#                                                         (faster_whisper)
#                                       "skip"            don't preload —
#                                                         caller hook
#                                                         handles it (tts
#                                                         piper voice).
#                                     Defaults to "snapshot" each.
#
#   POST_INSTALL_HOOK_ARM64=fn    — bash function (in caller scope) to
#   POST_INSTALL_HOOK_OTHER=fn      call after the chosen model loader
#                                   completes. Used for tts piper voice
#                                   file download on non-arm64.
#
# After sourcing, caller MUST call `install_service_main`.

set -euo pipefail

install_service_main() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"

  : "${SERVICE_LABEL:?install-template: SERVICE_LABEL is required}"
  : "${VENV_NAME:?install-template: VENV_NAME is required}"
  : "${DISK_REQUIRED_GB:?install-template: DISK_REQUIRED_GB is required}"
  : "${MODEL_ENV_VAR:?install-template: MODEL_ENV_VAR is required}"
  : "${PIP_DEPS_ARM64:?install-template: PIP_DEPS_ARM64 is required (empty string OK if unused)}"
  : "${PIP_DEPS_OTHER:?install-template: PIP_DEPS_OTHER is required (empty string OK if unused)}"

  # 1. Prereqs: python + disk + network (with OS system proxy detection
  # & per-source NO_PROXY classification, see prereq-check.sh).
  # shellcheck source=./prereq-check.sh
  source "$script_dir/prereq-check.sh"
  check_python3
  check_disk_space "$DISK_REQUIRED_GB"
  check_network

  # 2. Manual download-source overrides (user-supplied PIP / HF
  # endpoint overrides via .env or env). Best-effort — file may not
  # exist in all repos.
  if [ -f "$script_dir/../download-source-overrides.sh" ]; then
    # shellcheck source=../download-source-overrides.sh
    source "$script_dir/../download-source-overrides.sh"
    apply_manual_download_source_overrides
  fi

  # 3. Platform detection — picks the deps + model loader.
  local platform arch
  platform="$(uname -s)"
  arch="$(uname -m)"
  local is_darwin_arm64=0
  [ "$platform" = "Darwin" ] && [ "$arch" = "arm64" ] && is_darwin_arm64=1

  # 4. Pre-checks (optional binary requirements).
  if [ "${PRE_CHECK_FFMPEG:-0}" = "1" ]; then
    if ! command -v ffmpeg >/dev/null 2>&1; then
      echo "ERROR: ffmpeg 未安装，$SERVICE_LABEL 需要 ffmpeg。" >&2
      case "$platform" in
        Darwin) echo "  请运行: brew install ffmpeg" >&2 ;;
        Linux)  echo "  请运行: sudo apt install ffmpeg  # 或 dnf install ffmpeg" >&2 ;;
      esac
      exit 1
    fi
  fi

  # 5. Venv create (idempotent).
  local venv_dir="${CAT_CAFE_HOME}/${VENV_NAME}"
  if [ ! -d "$venv_dir" ]; then
    echo "  创建 venv: $venv_dir ..."
    "$PYTHON3" -m venv "$venv_dir" || { echo "ERROR: venv 创建失败" >&2; exit 1; }
  fi
  # shellcheck source=/dev/null
  source "$venv_dir/bin/activate"

  echo "  升级 pip ..."
  pip install --quiet -U pip

  # 6. pip install. Empty deps string = caller intentionally has no
  # pip deps on this platform branch (rare but supported).
  local pip_deps loader hook
  if [ "$is_darwin_arm64" = "1" ]; then
    pip_deps="$PIP_DEPS_ARM64"
    loader="${MODEL_LOADER_ARM64:-snapshot}"
    hook="${POST_INSTALL_HOOK_ARM64:-}"
  else
    pip_deps="$PIP_DEPS_OTHER"
    loader="${MODEL_LOADER_OTHER:-snapshot}"
    hook="${POST_INSTALL_HOOK_OTHER:-}"
  fi
  if [ -n "$pip_deps" ]; then
    echo "  安装依赖: $pip_deps ..."
    # shellcheck disable=SC2086
    pip install --quiet $pip_deps
  fi

  # 7. Model preload (with explicit retry + extended HF timeout).
  # MODEL_ENV_VAR holds the NAME of the env var; we look up its value.
  # `${!var}` is bash indirection — safe under `set -u` only when the
  # referenced var is defined, so we do an explicit defined-check first.
  local model_value=""
  if eval "[ -n \"\${${MODEL_ENV_VAR}:-}\" ]"; then
    eval "model_value=\"\$${MODEL_ENV_VAR}\""
  fi
  if [ "$loader" != "skip" ]; then
    if [ -z "$model_value" ]; then
      echo "ERROR: $MODEL_ENV_VAR 未设置。请通过 console install 按钮触发（自动按 scripts/services/recommendation-matrix.yaml 选型），或手动 $MODEL_ENV_VAR=<model-id> bash $0" >&2
      exit 1
    fi
    echo "  预下载模型: $model_value ..."
    _install_template_load_model "$venv_dir" "$loader" "$model_value"
  fi

  # 8. Post-install hook (e.g. piper voice file download).
  if [ -n "$hook" ]; then
    "$hook"
  fi

  echo "安装完成。"
}

_install_template_load_model() {
  # Args: venv_dir, loader, model_id
  # Runs the venv Python with explicit retry + HF_HUB_DOWNLOAD_TIMEOUT=60.
  # Single inline Python script per loader because we want both retry +
  # loader-specific entry point (snapshot_download vs WhisperModel)
  # without spawning multiple processes.
  #
  # Proxy: prereq-check.sh already decided whether HuggingFace needs
  # the system proxy (HF probe via candidate → exports
  # _CATCAFE_HF_PROXY_FOR_DOWNLOAD). We just consume that decision
  # here, per-call, so pip install (earlier step) goes direct via the
  # NO_PROXY classification and only HF model download gets the
  # proxy. No second detection inside Python — single source of
  # truth lives in prereq-check.
  local venv_dir="$1"
  local loader="$2"
  local model_id="$3"

  local hf_proxy_env=()
  if [ -n "${_CATCAFE_HF_PROXY_FOR_DOWNLOAD:-}" ]; then
    hf_proxy_env=(env "HTTP_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}" "HTTPS_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}")
    echo "  使用 HF 代理: ${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}（仅此模型下载子进程）"
  fi

  case "$loader" in
    snapshot)
      "${hf_proxy_env[@]}" "$venv_dir/bin/python" -c "
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from huggingface_hub import snapshot_download
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        snapshot_download(sys.argv[1])
        print('模型下载完成。')
        sys.exit(0)
    except Exception as e:
        print(f'  下载尝试 {attempt}/{max_attempts} 失败: {e}', file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  {wait}s 后重试...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: 模型下载失败，已尝试 {max_attempts} 次', file=sys.stderr)
sys.exit(1)
" "$model_id"
      ;;
    faster_whisper)
      "${hf_proxy_env[@]}" "$venv_dir/bin/python" -c "
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from faster_whisper import WhisperModel
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        WhisperModel(sys.argv[1], device='cpu', compute_type='int8')
        print('模型下载完成。')
        sys.exit(0)
    except Exception as e:
        print(f'  下载尝试 {attempt}/{max_attempts} 失败: {e}', file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  {wait}s 后重试...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: 模型下载失败，已尝试 {max_attempts} 次', file=sys.stderr)
sys.exit(1)
" "$model_id"
      ;;
    *)
      echo "ERROR: unknown MODEL_LOADER: $loader" >&2
      exit 1
      ;;
  esac
}
