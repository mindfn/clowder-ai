# Review Request: F257 LI-001 hold-ball action liveness

Review-Target-ID: f257
Branch: feat/f257-action-liveness
Review SHA: HEAD (implementation anchor: aa1104458)
Base: develop_base@07696d7b2

## What

Add an opt-in `completionRequirement: 'action-or-routing-exit'` contract to every `hold_ball` wake invocation. The contract survives direct and busy-queue dispatch and is enforced once in `routeSerial`: a successful empty or text-only response gets one bounded remedial invoke; a second violation emits a durable warning.

Existing routing exits and any `tool_use` satisfy the contract. Provider failures and cancellation remain their own terminal states. The wake-only contract applies to the original target and is not inherited by downstream A2A recipients.

## Why

`hold_ball` command/timer callbacks could carry an exit result and a concrete next step back to a cat, yet the cat could acknowledge in prose and end the invocation. The operator then had to push again manually. LI-001 turns that observed liveness failure into a structural, bounded dispatch invariant.

## Original Requirements

> “持球唤醒（wakeWhen 命令托管回调）带着 exit 1 结果 + 自己写的 nextStep 文本返回，Fable 把指令当通知回了 no-response——operator push「继续」才动。”
> “operator 原话：『我需要反复push你们才会动』。”
> “持球唤醒 dispatch 必须产出动作（tool call 或显式终态声明），no-response 结构拦截。”

- 来源：`/Users/lang/workspace/github-lab/clowder-ai-f257-harness-ledger/docs/features/assets/F257/harness-body-inputs.md`，A1 第五样本
- 候选定义：`/Users/lang/workspace/github-lab/clowder-ai-f257-harness-ledger/docs/features/assets/F257/live-candidates-2026-07-14.md`，LI-001
- 请对照摘录判断交付物是否解决了 operator 的问题。

## Tradeoff

- 采用显式结构元数据，不从 reminder prompt 文本推断策略。
- 复用现有 inline routing remedial，两个 guard 共享一次重试预算，避免一次 wake 触发两次补救。
- `tool_use` 表示已经形成可验证动作尝试；不等待工具结果成功才算 action，避免 provider/tool 失败被二次误判为“不行动”。
- 只实现 LI-001。下游 A2A 的 durable trigger/ack 状态机属于 LI-005，本提交不传播 wake-only requirement。

## Architecture Ownership

Architecture cell: dispatch

Map delta: none

Why: 仅扩展现有 ConnectorInvokeTrigger → InvocationQueue → AgentRouter → routeSerial 的 invocation metadata 与 completion validation；没有新增 Store、Queue、Router、Adapter、Dispatcher、Binding 或 ownership boundary。

请 reviewer 检查 diff 与 `Map delta: none` 是否一致。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
| --- | --- | --- |
| INV-1 opt-in | 只有 `hold_ball` wakeWhen 和 `hold-ball-*` timer task 设置 requirement；普通 connector/reminder 行为不变 | callback/reminder tests |
| INV-2 propagation | direct route 与 queued route 都将同一 requirement 送入 `routeSerial` | connector/queue processor tests |
| INV-3 dedupe monotonicity | queued dedupe 可以从无策略升级为有策略，但不能降级或丢失 | invocation queue test |
| INV-4 satisfaction | 任意 `tool_use` 或既有机械路由出口满足 contract | pure guard tests |
| INV-5 bounded budget | action-liveness 与 Codex routing guard 共用一次 remedial budget，最多两次 provider invoke | routeSerial shared-budget test |
| INV-6 terminal states | 首轮 provider error/abort 不触发 remedial；补救轮 provider error 不写 guard-failure notice | routeSerial error/abort tests |
| INV-7 visible failure | 两次成功但都无动作/出口时只写一次 `action-liveness-guard-failure` notice | routeSerial empty-twice test |
| INV-8 A2A scope | requirement 只约束原始 wake target，不传播给 worklist 中的下游猫 | routeSerial A2A scope test |

## E2E User Path Evidence

Scope verdict: 必做（猫/ operator 可感知的 routing liveness 行为）。

真实核心路径使用生产 `routeSerial` 与完整 dispatch-side mocks：

1. text-only acknowledgement → action-liveness remedial → non-routing tool action → no failure notice
2. empty success → one remedial → empty success → one durable failure notice, no third invoke
3. text-only acknowledgement → remedial provider error → provider error remains terminal, no false guard notice

执行命令：

```bash
cd /Users/lang/workspace/github-lab/cat-cafe-f257-action-liveness/packages/api
pnpm run build
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./scripts/with-test-home.sh \
  node --import $(pwd)/test/helpers/setup-cat-registry.js --test --test-timeout=60000 \
  test/callback-hold-ball-wakewhen.test.js \
  test/connector-invoke-trigger.test.js \
  test/invocation-queue.test.js \
  test/queue-processor.test.js \
  test/reminder-template.test.js \
  test/route-serial-routing-guard-remedial.test.js \
  test/routing-guard-remedial.test.js
```

结果：349 tests passed, 0 failed。

## Open Questions

### 技术 OQ

1. `tool_use` 作为 action attempt 的完成口径是否在所有 provider event adapter 上一致？
2. 当两个 guard 同时命中时优先使用 routing remedial prompt，是否保持了 action-liveness 的最小语义？
3. `hold-ball-*` task identity 是否覆盖全部 timer wake producer，同时不会误伤 public `dyn-*` reminder？
4. 请逐条验证 Invariant Matrix，并特别检查 error/abort 在补救轮中的状态聚合。

### 价值 OQ

无。该实现可由单 commit 回滚，不改变外部契约或生产数据边界。

## Next Action

请正式 reviewer：

1. 独立读取 truth source、plan 与 `07696d7b2...HEAD` diff。
2. 复跑最高风险的 pure-guard、routeSerial、connector/queue tests。
3. 每个 finding 标 P1/P2/P3 并给明确立场。
4. 对 review HEAD 给正式 APPROVE 或 REQUEST-CHANGES verdict，附验证证据与 reviewer 签名。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f257/codex`
- Start Command: `pnpm review:start`（本提交无 UI；只做代码/测试 review 时无需启动服务）
- Ports: `web=3201`, `api=3202`（禁止使用 runtime/alpha 保留端口）

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## 自检证据

### Spec 合规

- LI-001 action-or-routing-exit：已实现。
- direct / busy queue：均覆盖。
- text-only / empty / successful remedial / second violation / shared budget：均覆盖。
- provider error / abort：均保持独立终态。
- downstream A2A：明确不继承，未越界实现 LI-005。
- Architecture ownership：dispatch / none；无新 ownership object。
- Tips：plan frontmatter 含 `tips_exempt`，理由为纯服务端自动 guard，无 operator 可操作能力。
- UI / PEN：无 UI 改动；无匹配 F257/harness/liveness `.pen`。
- Artifact hygiene：工作树与提交 diff 均无根目录媒体/设计工件。

### 验证结果

```text
pnpm biome check . --diagnostic-level=error  -> 4502 files clean
pnpm lint                                     -> exit 0（仅既有 Web warnings）
pnpm -r --if-present run build                -> exit 0
七个定向 API suites                           -> 349 passed, 0 failed
git diff --check                              -> exit 0
pnpm check:followup-tails                     -> exit 0
```

全量基线例外（请勿把 author 声明当结论，可在 base 复核）：

- `pnpm test`：当前分支 exit 1；失败集中于 capability/provider 环境断言与缺失的 `scripts/signal-fetcher-launchd*.sh`。相同测试文件在 `develop_base@07696d7b2` 复跑为 92 tests / 71 pass / 21 fail，且同样缺脚本。本提交未改这些文件。
- `pnpm check`：Biome 与 review-worktree check 通过，随后被基线的 F258 ROADMAP 缺项和 F220 User Journey 缺项阻断；base 得到相同两项。
- `pnpm check:capability-tips`：hard-check 自测 11/11 通过，仓库级 7 个既有缺项在 base 同样存在。
- `pnpm gate`：脚本固定 rebase `origin/main`，不适用于本 fork 内部、基于 `develop_base` 的分支；在无关 Web 历史上冲突后已 `git rebase --abort`，HEAD 完整恢复到 `aa1104458`，工作树干净。

适用性判断：以上不是 LI-001 delta，故以“定向全绿 + build/lint/Biome 全绿 + base 对照”送审；请 reviewer 独立确认这一基线豁免是否成立。

### 相关文档

- Plan: `docs/features/assets/F257/action-liveness-implementation-plan.md`
- Diagnosis: `docs/bug-report/f257-action-liveness-remedial-provider-error/bug-report.md`
- Feature: F257 / LI-001

[砚砚/gpt-5.6-sol🐾]
