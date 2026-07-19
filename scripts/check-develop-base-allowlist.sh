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
# 白名单——每项标注真相源依据（sol F4：从 §14 + local override 推导，不重述实现）：
#
# 【文字明列】shared-rules.local.md「共享状态文档（ROADMAP / BACKLOG / 本文件）」：
#   BACKLOG.md                                —— local 明列
#   ROADMAP.md                                —— local 明列
#   cat-cafe-skills/refs/shared-rules.local.md —— local 明列「本文件」
# 【文字明列】upstream §14（.githooks/pre-commit Shared State Guard 既有清单）：
#   cat-config.json / docs/BACKLOG.md         —— upstream 共享状态定义（docs/ 前缀已被下条覆盖）
# 【直改惯例】develop_base 非 merge commit 实录（8263d2381 / d03e2bc3d / ede7a28ae 等）：
#   docs/**            —— feat 文档 / bug-report / discussions 状态与知识沉淀
#   review-notes/**    —— review 留痕
#   assets/**/*.md     —— 知识文档（assets/F257/redesign 系列）；二进制资产不在内
#
# 不在白名单（必须走 PR）：packages/**、scripts/**、.githooks/**、cat-template.json、
# cat-cafe-skills/**（上游 pack 内容，shared-rules.local.md 单文件例外见上）。
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
    cat-config.json) ;;                                # upstream §14 明列
    cat-cafe-skills/refs/shared-rules.local.md) ;;     # local 明列「本文件」（单文件例外）
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
    echo "白名单（§14+local 共享状态）：docs/** · review-notes/** · BACKLOG.md · ROADMAP.md ·"
    echo "  cat-config.json · cat-cafe-skills/refs/shared-rules.local.md · assets/**/*.md"
    echo "规则来源：shared-rules.local.md + upstream §14（LI-004 结构强制）"
  } >&2
  exit 1
fi

exit 0
