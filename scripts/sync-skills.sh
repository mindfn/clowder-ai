#!/usr/bin/env bash
# sync-skills.sh — 从 cat-cafe-skills/ 同步 symlinks 到当前项目的四猫 skills 目录
#
# 设计原则：启动目录 = 配置真相源
#   会话从哪个目录打开，skill 就从那个目录的 cat-cafe-skills/ 读取。
#   Agent 可能在会话中创建 worktree 干活，但 skill 上下文不变。
#   因此同步目标是当前项目目录，不是遍历所有 worktree。
#
# 同步目标：
#   1. 当前项目  .{claude,codex,gemini,kimi}/skills/  （project-level，relative symlinks）
#   2. HOME 级  ~/.{claude,codex,gemini}/skills/        （opt-in via --with-home，fallback）
#
# 用法: pnpm sync:skills [--dry-run] [--with-home]

set -euo pipefail

# Skill source: current project root (respects branch-specific skills)
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
SKILLS_SRC="$PROJECT_ROOT/cat-cafe-skills"

# All four harness names for project-level sync
HARNESSES=(claude codex gemini kimi)

# HOME-level dirs (absolute symlinks; check-skills-mount.sh expects this)
HOME_CLAUDE="$HOME/.claude/skills"
HOME_CODEX="$HOME/.codex/skills"
HOME_GEMINI="$HOME/.gemini/skills"

DRY_RUN=false
WITH_HOME=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --with-home) WITH_HOME=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

created=0
skipped=0
errors=0

sync_link() {
  local skill_name="$1"
  local target_dir="$2"
  local link_target="$3"
  local link_path="$target_dir/$skill_name"

  if [ -L "$link_path" ]; then
    local existing
    existing="$(readlink "$link_path")"
    if [ "$existing" = "$link_target" ]; then
      skipped=$((skipped + 1))
      return 0
    fi
    if $DRY_RUN; then
      printf "  ${YELLOW}[dry-run]${NC} would replace %s → %s\n" "$link_path" "$link_target"
      created=$((created + 1))
      return 0
    fi
    rm "$link_path"
  elif [ -e "$link_path" ]; then
    printf "  ${RED}SKIP${NC} %s (exists but not a symlink)\n" "$link_path"
    errors=$((errors + 1))
    return 0
  fi

  if [ ! -d "$target_dir" ]; then
    if $DRY_RUN; then
      printf "  ${YELLOW}[dry-run]${NC} would mkdir %s\n" "$target_dir"
    else
      mkdir -p "$target_dir"
    fi
  fi

  if $DRY_RUN; then
    printf "  ${YELLOW}[dry-run]${NC} would create %s → %s\n" "$link_path" "$link_target"
  else
    ln -s "$link_target" "$link_path"
    printf "  ${GREEN}✓${NC} %s → %s\n" "$skill_name" "$target_dir/"
  fi
  created=$((created + 1))
}

# Collect all skill names from source
skill_names=()
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue
  skill_names+=("$skill_name")
done

printf "\n${BOLD}Cat Café Skills Sync${NC}\n"
printf "源: %s (%d skills)\n" "$SKILLS_SRC" "${#skill_names[@]}"
$DRY_RUN && printf "${YELLOW}[DRY RUN MODE]${NC}\n"

# ─── Part 1: Current project (all four harnesses, relative symlinks) ───

printf "\n${BOLD}[Project]${NC} %s\n" "$PROJECT_ROOT"
for harness in "${HARNESSES[@]}"; do
  harness_skills="$PROJECT_ROOT/.$harness/skills"
  synced=0
  for skill_name in "${skill_names[@]}"; do
    before=$created
    sync_link "$skill_name" "$harness_skills" "../../cat-cafe-skills/$skill_name"
    [ "$created" -gt "$before" ] && synced=$((synced + 1))
  done
  if [ "$synced" -gt 0 ]; then
    printf "  ${GREEN}.%s/skills/${NC}: %d 修复\n" "$harness" "$synced"
  fi
done

# ─── Part 2: HOME-level (opt-in, absolute symlinks) ───

if $WITH_HOME; then
  printf "\n${BOLD}[HOME]${NC} ~/.{claude,codex,gemini}/skills/\n"
  for skill_name in "${skill_names[@]}"; do
    sync_link "$skill_name" "$HOME_CLAUDE" "$SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_CODEX"  "$SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_GEMINI" "$SKILLS_SRC/$skill_name"
  done
else
  printf "\n${BOLD}[HOME]${NC} 跳过（使用 --with-home 启用）\n"
fi

# ─── Part 3: Write skills-state.json ───

if ! $DRY_RUN; then
  STATE_DIR="$PROJECT_ROOT/.cat-cafe"
  STATE_FILE="$STATE_DIR/skills-state.json"
  mkdir -p "$STATE_DIR"

  MANIFEST_HASH="sha256:$(printf '%s\n' "${skill_names[@]}" | sort | shasum -a 256 | cut -c1-16)"
  SYNCED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SOURCE_ROOT="${SKILLS_SRC#"$PROJECT_ROOT"/}"

  SORTED_NAMES=$(printf '%s\n' "${skill_names[@]}" | sort | awk '{printf "    \"%s\"", $0; if (NR<TOTAL) printf ","; printf "\n"}' TOTAL="${#skill_names[@]}")
  cat > "$STATE_FILE" <<EOJSON
{
  "managedSkillNames": [
${SORTED_NAMES}
  ],
  "sourceRoot": "${SOURCE_ROOT}",
  "sourceManifestHash": "${MANIFEST_HASH}",
  "lastSyncedAt": "${SYNCED_AT}"
}
EOJSON

  printf "${BOLD}[State]${NC} ${GREEN}✓${NC} %s (hash: %s)\n" "$STATE_FILE" "$MANIFEST_HASH"
fi

# ─── Summary ───

printf "\n${BOLD}结果${NC}: "
if [ "$created" -gt 0 ]; then
  printf "${GREEN}%d 新建/修复${NC} " "$created"
fi
printf "%d 已正确 " "$skipped"
if [ "$errors" -gt 0 ]; then
  printf "${RED}%d 错误${NC}" "$errors"
fi
printf "\n\n"

if [ "$created" -gt 0 ] && ! $DRY_RUN; then
  printf "${YELLOW}提示${NC}: 项目级 symlinks 需要 git add + commit 才能持久化\n"
  printf "  git add .{claude,codex,gemini,kimi}/skills/ && git commit -m 'fix(skills): sync missing symlinks'\n\n"
fi

exit "$errors"
