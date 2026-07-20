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
# 白名单——穷举五项，严格从 §14 + local override 推导（sol R2 P1-3 收窄裁决）：
#
# 【文字明列】shared-rules.local.md「共享状态文档（ROADMAP / BACKLOG / 本文件）」：
#   BACKLOG.md                                —— local 明列
#   ROADMAP.md                                —— local 明列
#   cat-cafe-skills/refs/shared-rules.local.md —— local 明列「本文件」
# 【文字明列】upstream §14（.githooks/pre-commit Shared State Guard 既有清单）：
#   cat-config.json                           —— upstream 共享状态定义
#   docs/BACKLOG.md                           —— upstream 旧清单位置
#
# 收窄移出（改走 PR 或 operator --no-verify）：
#   docs/**（feat-doc 等知识文档）、review-notes/**、assets/**/*.md
# ⚠️ 行为变更：8263d2381 形态（feat-doc 直改 develop_base）将被拦。
# §14 原文「BACKLOG 等共享状态」存在开放类目读法，若合入后直改摩擦显著，
# 扩围决策升 operator（附 git log 证据一行 PR 即可扩）。
#
# 不在白名单（必须走 PR）：packages/**、scripts/**、.githooks/**、cat-template.json、
# docs/**（非穷举项）、review-notes/**、assets/**、cat-cafe-skills/**（shared-rules.local.md 单文件例外）。
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
    BACKLOG.md) ;;                                     # local 明列
    ROADMAP.md) ;;                                     # local 明列
    cat-config.json) ;;                                # upstream §14 明列
    cat-cafe-skills/refs/shared-rules.local.md) ;;     # local 明列「本文件」（单文件例外）
    docs/BACKLOG.md) ;;                                # upstream §14 旧清单位置
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
    echo "白名单（§14+local 穷举五项）：BACKLOG.md · ROADMAP.md · cat-config.json ·"
    echo "  cat-cafe-skills/refs/shared-rules.local.md · docs/BACKLOG.md"
    echo "规则来源：shared-rules.local.md + upstream §14（LI-004 结构强制）"
  } >&2
  exit 1
fi

exit 0
