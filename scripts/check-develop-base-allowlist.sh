#!/bin/bash
# F257 修复清单 #5 — 运行实例写保护（develop_base 分支白名单）
#
# 证据坐标：dev-af6d4e28（平行实例任务错位 merge 污染运行基线，V1 一度整体不在运行树）。
# 目标：把 LI-004「运行实例对代码只读」从认知纪律降为结构强制（修补环 O2→O1）。
#
# 语义：develop_base 是运行基线分支——代码只能经 feature 分支 → PR → GitHub merge →
# 运行实例 pull 进入；develop_base 上的本地直接 commit 仅允许 §14 共享状态文档。
#
# 用法：check-develop-base-allowlist.sh <branch>
#   staged 文件列表从 stdin 读入（一行一个；由 pre-commit 传 git diff --cached --name-only）
#   exit 0 = 放行；exit 1 = 拒绝（stderr 点名越界文件）
#
# 白名单（§14 共享状态文档，shared-rules.local.md 口径）：
#   docs/**            —— feat 文档 / bug-report / discussions 等知识与状态沉淀
#   review-notes/**    —— review 留痕
#   BACKLOG.md         —— 根目录热状态
#   ROADMAP.md         —— 根目录热状态
#   assets/**/*.md     —— 知识文档（如 assets/F257/redesign）；二进制资产不在内
#
# 绕过：git commit --no-verify（家规约束下仅限 operator 显式授权场景）。

BRANCH="$1"

# 只保护 develop_base；feature / main / 其他分支不受白名单限制
if [ "$BRANCH" != "develop_base" ]; then
  exit 0
fi

violations=()
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    docs/*) ;;
    review-notes/*) ;;
    BACKLOG.md) ;;
    ROADMAP.md) ;;
    assets/*.md) ;; # bash case 的 * 跨路径分隔符：覆盖 assets/ 下任意深度的 .md
    *) violations+=("$file") ;;
  esac
done

if [ ${#violations[@]} -gt 0 ]; then
  {
    echo ""
    echo "🚫 DEVELOP-BASE GUARD (F257 #5 / dev-af6d4e28): develop_base 只允许共享状态文档直接 commit！"
    echo ""
    echo "越界文件："
    printf '  - %s\n' "${violations[@]}"
    echo ""
    echo "develop_base 是运行基线：代码与配置改动必须走 feature worktree → PR → merge 后 pull。"
    echo "  1. git restore --staged <files>"
    echo "  2. 在 feature worktree（git worktree add ../<name> -b feat/<name> origin/develop_base）里改"
    echo "  3. PR → review → GitHub merge → 运行实例 git pull"
    echo ""
    echo "白名单（§14 共享状态文档）：docs/** · review-notes/** · BACKLOG.md · ROADMAP.md · assets/**/*.md"
    echo "规则来源：shared-rules.local.md（LI-004 结构强制）"
  } >&2
  exit 1
fi

exit 0
