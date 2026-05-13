#!/usr/bin/env bash
# scripts/services/python-resolve.sh
#
# Unified Python 3.12+ interpreter resolver, shared by all service install
# scripts (whisper / tts / embed / llm) and the agent CLI installer (kimi).
#
# Goals:
#   - Don't fight the user's environment: reuse any system Python or
#     multi-version manager (uv / pyenv / brew) the user already has.
#   - Don't push uv / pyenv on users who haven't opted in. We *reuse* them,
#     but never auto-install them as a precondition.
#   - When nothing on the system satisfies our requirements, fall back to a
#     project-owned interpreter under ~/.cat-cafe/python-x64/ so we don't
#     touch the user's system Python at all.
#
# Resolution order (first match wins, falls through on failure):
#   1. System Python candidates (python3.13, python3.12, py -3.12, python).
#      Accept anything with major.minor >= 3.12 AND a working venv module.
#      On Windows ARM64 we additionally require AMD64 architecture (Prism
#      emulation) — native ARM Python can't pip-install several deps.
#   2. uv (if user already has it) — uv python find 3.12 reuses uv-managed
#      builds or the user's pyenv toolchain.
#   3. pyenv (Linux/macOS, if installed) — query installed 3.12.x version
#      or install one if not present.
#   4. Homebrew (macOS, if installed) — brew --prefix python@3.12.
#   5. Project-owned Python in ~/.cat-cafe/python-x64/ (or platform-equivalent)
#      — only when nothing above worked.
#
# Usage from an install script:
#   source "$(dirname "$0")/python-resolve.sh"
#   resolve_python_312     # sets RESOLVED_PYTHON to the absolute path
#   "$RESOLVED_PYTHON" -m venv ~/.cat-cafe/whisper-venv
#
# Exit codes:
#   0 — RESOLVED_PYTHON set, ready to use
#   1 — no interpreter could be resolved (user must intervene)

RESOLVED_PYTHON=""
RESOLVED_PYTHON_ARCH=""   # native | x86_64 (== amd64) | unknown
RESOLVED_PYTHON_SOURCE="" # system | uv | pyenv | brew | project

_CAT_CAFE_HOME="${HOME}/.cat-cafe"
_PROJECT_PYTHON_DIR="${_CAT_CAFE_HOME}/python"

# Pinned python-build-standalone release. Same kind of portable Python
# tarball that uv / pyenv / rye fetch. The project moved from
# github.com/indygreg to github.com/astral-sh in 2025, both org+release+version
# need to match a real existing asset (verified via curl -I 200 OK before pinning).
_PBS_OWNER="astral-sh"
_PBS_RELEASE="20260510"
_PBS_VERSION="3.12.13"

_python_version_ok() {
  # Args: python_command [arg...]
  # Echoes "<major>.<minor> <machine>" on success and returns 0; returns 1 on failure.
  local cmd_out
  cmd_out=$("$@" -c 'import sys, platform; print(f"{sys.version_info.major}.{sys.version_info.minor} {platform.machine().lower()}")' 2>/dev/null) || return 1
  local ver machine major minor
  ver="${cmd_out% *}"; machine="${cmd_out##* }"
  major="${ver%.*}"; minor="${ver#*.}"
  # major>=3 AND minor>=12 (in practice major is always 3, but be explicit)
  if [ "$major" -lt 3 ]; then return 1; fi
  if [ "$major" -eq 3 ] && [ "$minor" -lt 12 ]; then return 1; fi
  # Confirm venv module works — some distros ship python without it.
  "$@" -c 'import venv' >/dev/null 2>&1 || return 1
  printf '%s %s\n' "$ver" "$machine"
  return 0
}

_arch_acceptable_for_platform() {
  # Args: machine_string
  # On Windows we'd be checking AMD64, but this resolver runs on POSIX only;
  # the PowerShell version (python-resolve.ps1) enforces AMD64. Here we
  # accept any architecture — Linux/macOS native interpreters work.
  return 0
}

_try_system_pythons() {
  local cmd ver_out
  for cmd in python3.13 python3.12 python3 python; do
    if ! command -v "$cmd" >/dev/null 2>&1; then continue; fi
    ver_out=$(_python_version_ok "$cmd") || continue
    local machine="${ver_out##* }"
    _arch_acceptable_for_platform "$machine" || continue
    RESOLVED_PYTHON="$(command -v "$cmd")"
    RESOLVED_PYTHON_ARCH="$machine"
    RESOLVED_PYTHON_SOURCE="system"
    return 0
  done
  return 1
}

_try_uv() {
  command -v uv >/dev/null 2>&1 || return 1
  # uv python find prints absolute path of a matching interpreter — or fails.
  # We don't ask uv to install (that would silently grow user state); we only
  # reuse what uv already has.
  local found
  found=$(uv python find '>=3.12' 2>/dev/null) || return 1
  [ -n "$found" ] && [ -x "$found" ] || return 1
  RESOLVED_PYTHON="$found"
  RESOLVED_PYTHON_ARCH="$($found -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="uv"
  return 0
}

_try_pyenv() {
  command -v pyenv >/dev/null 2>&1 || return 1
  local installed
  installed=$(pyenv versions --bare 2>/dev/null | grep -E '^3\.(1[2-9]|[2-9][0-9])' | head -1)
  if [ -z "$installed" ]; then return 1; fi
  local py
  py=$(pyenv root)/versions/${installed}/bin/python
  [ -x "$py" ] || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="pyenv"
  return 0
}

_try_brew() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  local brew_prefix
  brew_prefix=$(brew --prefix python@3.12 2>/dev/null) || return 1
  local py="${brew_prefix}/bin/python3.12"
  [ -x "$py" ] || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="brew"
  return 0
}

_try_project_python() {
  local py="${_PROJECT_PYTHON_DIR}/bin/python3"
  [ -x "$py" ] || return 1
  _python_version_ok "$py" >/dev/null || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="project"
  return 0
}

_pbs_target_triple() {
  # Determine which python-build-standalone target tarball matches this host.
  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64|aarch64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) return 1 ;;
      esac
      ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
        x86_64) echo "x86_64-unknown-linux-gnu" ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  return 0
}

_install_project_python() {
  # Download python-build-standalone tarball and extract to ~/.cat-cafe/python/.
  # No root, no system PATH changes; the resolver's _try_project_python picks
  # it up via $RESOLVED_PYTHON afterwards.
  local triple
  triple=$(_pbs_target_triple) || return 1
  command -v curl >/dev/null 2>&1 || { echo "  curl required to bootstrap project Python — please install curl" >&2; return 1; }
  command -v tar >/dev/null 2>&1 || { echo "  tar required to bootstrap project Python" >&2; return 1; }

  local tar_url="https://github.com/${_PBS_OWNER}/python-build-standalone/releases/download/${_PBS_RELEASE}/cpython-${_PBS_VERSION}+${_PBS_RELEASE}-${triple}-install_only.tar.gz"
  local tmpdir
  tmpdir=$(mktemp -d) || return 1
  echo "  Downloading portable Python ${_PBS_VERSION} (${triple}) from python-build-standalone..."
  if ! curl -fLs "$tar_url" -o "${tmpdir}/python.tar.gz"; then
    echo "  Failed to download $tar_url" >&2
    rm -rf "$tmpdir"
    return 1
  fi
  mkdir -p "$_PROJECT_PYTHON_DIR"
  # Tarball extracts into a top-level "python/" directory — strip that one
  # component so files land directly in $_PROJECT_PYTHON_DIR.
  if ! tar -xzf "${tmpdir}/python.tar.gz" -C "$_PROJECT_PYTHON_DIR" --strip-components=1; then
    echo "  Failed to extract Python tarball" >&2
    rm -rf "$tmpdir"
    return 1
  fi
  rm -rf "$tmpdir"
  echo "  Python ${_PBS_VERSION} installed to $_PROJECT_PYTHON_DIR (project-owned, no system changes)"
  return 0
}

resolve_python_312() {
  RESOLVED_PYTHON=""; RESOLVED_PYTHON_ARCH=""; RESOLVED_PYTHON_SOURCE=""
  _try_system_pythons && return 0
  _try_uv && return 0
  _try_pyenv && return 0
  _try_brew && return 0
  _try_project_python && return 0
  # Last resort: download a portable interpreter to ~/.cat-cafe/python/.
  if _install_project_python && _try_project_python; then return 0; fi
  echo "ERROR: no Python 3.12+ interpreter found and the portable Python fallback also failed." >&2
  echo "  You can install one manually:" >&2
  case "$(uname -s)" in
    Darwin) echo "    brew install python@3.12   # or download from https://www.python.org/downloads/" >&2 ;;
    Linux)  echo "    sudo apt install python3.12 python3.12-venv  # (Debian/Ubuntu with deadsnakes)" >&2
            echo "    # or:  curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12" >&2 ;;
    *)      echo "    See https://www.python.org/downloads/" >&2 ;;
  esac
  return 1
}
