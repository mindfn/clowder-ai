# Review Request: F257 回放现场聚焦来源上下文

Review-Target-ID: `f257-replay-context-focus`
Branch: `fix/f257-replay-context-focus`
Implementation commit: `70263100c6aa94f1150a459fdfd9496d1bcefab3`
Base: `origin/develop_base@b5d17f780caa2d505705c776ce8bde2b8e977ae4`
Reviewer: `@opus`

## What

- 回放 modal 的 primary surface 只保留来源 Thread、Message anchor 和周边对话上下文。
- Thread 改为可点击链接，在新窗口打开既有 `/thread/[threadId]` 路由，并带 `noopener noreferrer`。
- 移除现场内容、模板来源、变量、版本和 window-correlated guard 等渲染/调试字段；API response 与 durable replay snapshot 不变。
- Message anchor 缺失时显示“无消息锚点”，同时继续呈现结构化 gap 原因。

## Why

operator 要解决的是“这次观测来自哪次对话、前后说了什么”。模板渲染和时间窗关联的守卫事件属于深度审计数据，在 primary surface 中会压过真正的现场坐标；尤其 window correlation 不是因果证明，不应在这里暗示因果关系。

## Original Requirements（必填）

> “守卫事件是什么……回放现场大部分数据不需要，只要最下面上下文和来源 thread/messageid；模板、变量、现场内容都不需要；点击 thread 可以新开窗口跳转过去？”

- 来源：协作 thread `thread_mrdip0u5aw4ysi97`，消息 `0001785842696227-000000-bf17d27f`。
- 请按“primary surface 只保留来源坐标 + 上下文”和“Thread 新窗口跳转”判断完成度，不把 API 中继续保留审计字段误判为 UI 遗漏。

## Tradeoff

- modal 不再重复展示时间；观测时间仍在打开 modal 的父层 Lifeline / Trace 列表中。这样保留时序坐标，同时避免违背本次精简目标。
- 深度审计字段仍由既有 API response 和 durable snapshot 提供，本次没有删除、迁移或改写持久数据。
- 未新增 message 定位 query：当前稳定契约只有 thread 路由；Message anchor 仍作为精确证据坐标展示，避免伪造不存在的前端 deep-link 契约。

## Architecture Ownership（必填）

Architecture cell: `harness-eval`
Map delta: `none`
Why: 本次只收敛既有 replay response 的 Console 投影，没有改变 response schema、durable snapshot、Store / Queue / Router / Adapter / Dispatcher / Binding 或 extension point。

请 reviewer 检查：

- `Map delta: none` 是否与纯 UI projection diff 一致；
- 隐藏调试字段后，API 类型和可审计数据是否仍完整；
- Thread 链接是否使用真实 route、安全的新窗口属性及 URL encoding；
- anchor 为 null 时是否诚实显示空值与 gap，而不是吞掉缺失语义。

## Invariants

- INV-1：UI 隐藏调试字段，但 `SegmentReplayResponse` 与持久 replay snapshot 不变。
- INV-2：来源坐标保持诚实：Thread 始终可跳转；Message anchor 为空时显示“无消息锚点”并保留 gap。
- INV-3：观测时间仍由父层 tracing list 展示，modal 不重复同一时序信息。

## Review Verdict

- Opus 对 exact implementation SHA `70263100c6aa94f1150a459fdfd9496d1bcefab3` 完成跨个体 review。
- Verdict：**APPROVE — 0 P1 / 0 P2 / 1 P3**。
- 证据消息：`0001785844176811-000034-ac5efd03`。
- P3 disposition：不回补 modal 时间戳。父层已提供时序信息，且本次需求明确要求精简 primary surface；后续只有在 operator 实际体验证明缺少时间参照时才重新评估。

## Close Matrix（本切片）

| Requirement | Evidence | Result |
|---|---|---|
| 只保留上下文和 thread/messageid | `SegmentReplayPanel.tsx` 仅渲染“来源”“上下文”；反向断言覆盖 6 个隐藏 label | PASS |
| Thread 可新窗口跳转 | `/thread/${encodeURIComponent(threadId)}` + `_blank` + `noopener noreferrer` + aria-label | PASS |

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f257/opus`
- Start command: `pnpm review:start`
- Ports: `none`；本次 exact-SHA review 通过静态 diff、类型与定向测试完成，不访问运行实例 3001 / 3002 或 Redis 6099。

## 自检证据

### Repository gate

```bash
bash ./scripts/pre-merge-check.sh --no-rebase --skip-install
# exit 0 — GATE PASSED
# build 22s; tsc 7s; test 756s; lint+check 46s; total 831s
```

- `--no-rebase` 是 fork-internal `develop_base` 分支的正确模式；实现 commit 的唯一 parent 与最新 `origin/develop_base` 都是 `b5d17f780caa2d505705c776ce8bde2b8e977ae4`，`git merge-base --is-ancestor origin/develop_base HEAD` 返回 0。
- build、TypeScript（含 tests）、public API 全量测试、web lint、Biome 与 repository checks 全部通过。
- lint / capability-tip advisory 为仓库既有 warning；0 error。gate 末尾 dirty-ledger 只列出其他 worktree，目标 worktree本身 clean。

### 定向回归

```bash
pnpm --filter @cat-cafe/web exec vitest run \
  src/components/settings/__tests__/SegmentReplayPanel.test.tsx \
  src/components/settings/__tests__/LifelineStageDetail-replay.test.tsx
# 2 files / 8 tests passed

pnpm check:capability-tips
# 11 tests passed; check PASS（7 个既有 warning）

git diff --check
# clean
```

- 正向覆盖来源链接、anchor 与上下文；反向覆盖现场内容、内容来源、模板来源、版本、变量绑定、守卫事件均不再渲染。
- `SegmentReplayResponse` 未修改，包含 `timestamp`、`version`、`content`、`contentSourceKind`、`templateRef`、`templateVars`、`guardEvents` 及 gap 字段。
- 人工 architecture / fallback audit：只新增一处 `messageAnchorId ?? '无消息锚点'`；无三层 fallback，无新架构 owner。公开 fork 不包含 quality-gate 引用的 `check:architecture-ownership`、`check-hotfix-pattern.mjs`、`check-fallback-layers.mjs`，未伪报为已运行。

### UI / artifact evidence

- 既有 `/thread/[threadId]` route 已从源码核验；组件测试验证 link href、target、rel 与可访问性标签。
- 本地 Browser Node REPL 接口在当前 agent surface 未暴露，因此没有伪造截图或录屏；UI 行为由 jsdom 交互测试与 Opus exact-SHA review 覆盖。
- 本切片不涉及 `.pen` / 设计资产；根目录 artifact hygiene 与 `git diff --check` 均 clean。
- quality-gate 文档引用的 `vision-evidence-workflow.md`、`evidence-output-contract.md` 在当前公开 fork skill 包中缺失，已按现有 requirements + evidence contract 人工完成 close matrix。

[砚砚/gpt-5.6-sol🐾]
