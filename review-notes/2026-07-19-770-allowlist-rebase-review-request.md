# Review Request: PR #1081 (#770 System Settings allowlist) — post-rebase

- **Date**: 2026-07-19
- **Author**: 布偶猫/宪宪 (@cat-8zfu14fb, Fable)
- **Reviewer**: 缅因猫 sol (@sol, cat-eqdvbcxw) — 跨家族
- **Review-Target-ID**: 770-settings-system-allowlist
- **Branch**: `feat/770-settings-system-allowlist`
- **HEAD**: `afff4532b` (= origin = PR #1081 head)
- **Worktree (read-only for reviewer)**: `/Users/lang/workspace/github-lab/cat-cafe-770-settings-system-allowlist`
- **Diff range**: `accc53eb3..afff4532b`（base = upstream/main @ #1172 merge，7 commits）
- **PR**: https://github.com/zts212653/clowder-ai/pull/1081（现 MERGEABLE；cloud codex review 已并行触发）

## Original Requirements

来源：本 thread opener（co-creator，thread_mpf86bj4ejq306oo）+ upstream issue #770：

> 当前我们setting配置这里有太多配置项了；但是其实大部分配置都应该分散而且已经分散到各个模块下去了的；我们真正需要在setting这里编辑和管理的配置并没有这么多……哪些配置是冗余的；哪些是真正需要在系统配置这里管理的

方案共识（thread 内定稿）：**后端硬编码 SYSTEM_VARS allowlist 直接定义子集**，不给 200+ 变量加 `settingsSurface` 元数据；`runtimeEditable` fail-closed + `restartRequired` 元数据保留。请对照判断：diff 是否忠实于这个方向。

## What（本轮 delta——review 重点）

PR 整体此前已过多轮 cloud codex + 本地 review。**本轮新鲜、未被 review 的部分是 rebase 冲突解决的语义决策**：

1. **恢复 3 个 quota 变量**（`QUOTA_OFFICIAL_REFRESH_ENABLED` / `CLAUDE_CREDENTIALS_PATH` / `CODEX_CREDENTIALS_PATH`）：上游 #1172 (`ca0536073`) 新增测试断言它们 registered + `buildEnvSummary()` 可见 + credentials 两个 `runtimeEditable: false`。采用上游最新定义（含 `~/.codex/auth.json` 新默认值）。落点 commit `91cff4a4c`。
2. **`quota` 回归 `EnvCategory` union + `ENV_CATEGORIES`**（label `额度监控`）——rebase 才暴露的 TS2322，fixup 进 `91cff4a4c`（非独立 commit）。
3. **env-registry.test.js 冲突合并**（commit `148f28b4e`）：保留上游新 quota credential 测试 + 我们的 `GITHUB_WEBHOOK_SECRET` sensitive 测试；删除 3 个已 prune 变量（`OPENAI_API_KEY` / `KIMI_QUOTA_API_FALLBACK_ENABLED` / `KIMI_CONFIG_FILE`）的测试——删除依据：这 3 个 var 已不在 registry（grep 计数 0）。

## Why

上游 #1172 与我们的 pruning 在同一文件相向而行：他们要求 quota 3 var 保留可见，我们删了整个 quota 段。解法利用 #770 架构的双面性：**quota vars 经 `buildEnvSummary()` 对 quota 页可见，但不在 `SYSTEM_VARS`，System 页照样不显示**。两个需求正交，无需牺牲任一方。

## Invariant Matrix（请逐条验证）

| # | 不变量 | 真相源 | 执行点 |
|---|--------|--------|--------|
| I1 | `runtimeEditable` 未显式 `true` 的 var，Hub PATCH 必须拒绝（fail-closed） | `env-registry.ts` 各定义 | `isEditableEnvVar()` + `routes/config.ts` PATCH |
| I2 | System 页只返回 `SYSTEM_VARS ∩ hubVisible` | `SYSTEM_VARS` Set | `buildSystemEnvSummary()` |
| I3 | `buildEnvSummary()` 返回全部 hubVisible vars（quota 3 var 必须在内——上游 #1172 测试） | `ENV_VARS` | `buildEnvSummary()` |
| I4 | 恢复的 quota credentials 不可热编辑（`runtimeEditable: false`） | 同上 | 同 I1 |

## 自检证据（quality-gate，2026-07-19 实跑）

- `packages/api` build OK（fixup 前曾 TS2322 fail，修复后绿）
- `env-registry.test.js` + `config-event-bus.test.js`: **62/62 pass**（含上游新 quota 测试）
- `check:env-registry` + `check:env-example`: **10/10**；`check:env-ports`: **24/24**
- web `hub-env-files-tab.test.tsx`: **7/7**；`pnpm lint`: 无新告警（仅 pre-existing，非本 PR 文件）
- 根目录工件闸门：working tree + diff 均空；`git status` clean

## E2E User Path Evidence

本轮 delta 纯后端 registry/test 文件，**前端零变更**（前端 3 文件是历史 commit，此前已在预览实例 3301/3302/6778 供 operator 验收）。豁免理由：rebase 未触碰任何 UI 路径；System 页行为由 I2 测试覆盖。

## Open Questions

**技术 OQ**（给 sol）：
1. test 冲突合并时我删了 3 个已 prune var 的测试——是否有其他上游测试文件仍引用这 3 个 var（我 grep 了 `packages/api/test` 与 `scripts/`，未见；请独立复核）。
2. quota 3 var 恢复后，`check-env-example` 的 ALLOWLIST 语义是否仍自洽（10/10 过，但请看语义而非只看绿灯）。

**价值 OQ**：无——方向已在 thread 内与 operator 定稿。

## Next Action

sol review → verdict 三选一（放行 / 退回 + 理由）。verdict 落 PR 的话走 `gh pr comment`（同 GH 账号不可 `--approve`，见 skill §reviewer verdict）。cloud codex 并行在跑，两路 finding 我统一按 receive-review 处理。

[宪宪/Fable🐾]
