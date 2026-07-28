# Review Request: TeamAct push / pull / ACK 语义校准

Review-Target-ID: teamact-push-pull-semantics
Branch: docs/teamact-push-pull-semantics

## What

校准 TeamAct 范式文、技术文章、差距迁移文和两张配图：

- 将同名的 push / pull 拆成工作调度、上下文取得、消息投递与 ACK 三个平面；
- 明确当前 A2A 是“定向消息 → 入队 → 主动触发 invocation → 注入增量上下文”的 push 实现；
- 将 pull 定义为从共享结构化协调状态 / 工作池发现工作并 CAS 认领，而非扫描群聊；
- 引入逐消息 × 逐接收者的 `created → enqueued → delivered → seen → processed` ACK 链，并与 Claim / fulfilled 责任状态机分离。

## Why

旧稿把可靠性边界压缩成“push 只唤醒、durable pull 兜底”，既没有准确描述当前主动触发实现，也掩盖了两个真实缺口：增量上下文可能让非目标猫误读，以及当前缺少逐接收者 ACK。

## Original Requirements（必填）

> “pull和push你写简单了吧；我们当前是push实现，主动触发，但是代价是其他人可能误读，取决于实现，需要考虑ack?(当前少了的) pull的话则是类似 share state的方式；？”

- 来源：thread `thread_mruayc4owlyzazbx`，message `0001785210531141-001466-63a07089`
- **请对照上面的摘录判断交付物是否解决了 operator 的问题。**

## Tradeoff

保留 hybrid 结论，但不再用一句“push 只唤醒”代替机制：

- push 仍负责低延迟的主动调度，可携带定向 envelope 并启动目标 invocation；
- durable shared state 承担事实真相，pull discovery 承担漏触发后的工作发现；
- ACK 负责消息接收证据，Claim / fulfilled 负责工作责任，二者不互相代替。

代价是范式正文增加一张三平面对照表和完整 ACK 链；收益是实现、范式和迁移差距使用同一组可验证术语。

## Architecture Ownership（必填）

Architecture cell: dispatch / coordination semantics（文档切片）
Map delta: none
Why: 只校准已有 TeamAct 文档与配图，不新增或改变运行时 Store / Queue / Router / Adapter / Dispatcher / Binding 的 ownership。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 范式描述是否错误承诺了当前运行时已经具备逐接收者 ACK 或共享工作池；
- gap 文档列出的当前实现链路是否与代码一致。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|--------|---------|---------|
| INV-1 | push 可以主动入队、触发 invocation、携带定向 envelope；“触发成功”不等于接收方 ACK | 对照 `callback-a2a-trigger.ts`、`QueueProcessor.ts` 与三份文档 |
| INV-2 | 消息 ACK 是逐消息 × 逐接收者；`enqueued / delivered / seen / processed` 不与 `Claim / fulfilled` 合并 | 全文术语扫描 + 范式 §4.4 / gap G15、S1、S2 对照 |
| INV-3 | pull discovery 从结构化共享协调状态 / 工作池读取，不把群聊扫描冒充 pull | 范式 §3.2、技术文章判断⑦、两张图对照 |
| INV-4 | 工作调度的 push / pull 与上下文取得的 push / pull 正交 | 范式 §3.2、§4.3 和 Figure B 对照 |
| INV-5 | 技术文章保持对外概念化，不泄漏内部文件名、Feature ID 或实测数据 | `rg` 扫描文章 + 人工阅读 |

## E2E User Path Evidence

可豁免（理由：纯 Markdown / SVG 语义修订，无运行时或前端行为变化）。两张 SVG 已经 `xmllint` 校验并用 Quick Look 原尺寸渲染目检，无截断或重叠。

## Open Questions

### 技术 OQ（给 reviewer）

1. 三平面拆分是否完整，尤其“调度 push”与“上下文 push”是否仍有歧义？
2. `enqueued → delivered → seen → processed` 的边界是否足够严格，是否还缺少能影响迁移设计的 ACK 状态？
3. gap 文档对现状的判断是否准确：当前 message-level `deliveryStatus` 和连续 per-cat cursor 仍不能表达 sparse per-recipient ACK？
4. public article 是否仍有内部实现泄漏，SVG 是否和正文一致？

请 reviewer 逐条验证 Invariant Matrix。

### 价值 OQ（给 operator，如有）

无。

## Next Action

请 Fable 对提交 HEAD 做跨家族正式 review，在 PR comment 中给出明确 `APPROVE` 或分级 findings；重点核对当前实现链、ACK 边界和 pull 的 shared-state 定义。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/teamact-push-pull-semantics/Fable`
- Start Command: 不适用（docs-only；直接检出 detached HEAD 审阅）
- Ports: `web=N/A`, `api=N/A`

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
```

## 自检证据

### Spec 合规

- 原始纠偏逐项落入范式、公开文章、gap 和两张图；
- 当前实现判断来自 `enqueueA2ATargets`、`QueueProcessor.markDelivered`、`routeExecution`、`assembleIncrementalContext` 与 `DeliveryCursorStore`；
- 旧短语 `push 只唤醒` / `durable pull 兜底` 已从三份目标文档移除。

### 测试结果

```text
env -u NODE_ENV pnpm install --frozen-lockfile  # PASS
pnpm lint                                      # PASS（仅基线 warnings）
pnpm build                                     # PASS
git diff --check                               # PASS
xmllint --noout <2 changed SVGs>                # PASS
Quick Look render + visual inspection          # PASS

pnpm check                                     # BASELINE BLOCKED
  Biome: 4614 files checked, PASS
  后续失败：Active feature F258 missing from ROADMAP；
            F193 active feature doc lacks User Journey

pnpm test                                      # BASELINE BLOCKED
  失败集中在 fork/develop_base 已缺失的 AGENTS.md anchors、
  .claude/settings/hooks 和 scripts/signal-fetcher-launchd.sh 等仓库资产。
  本分支只改 3 个 Markdown、2 个 SVG 和本 review request，无运行时代码差异。
```

`request-review` 的“测试全绿”前置在此 fork 基线上不可满足。本轮按 Rule 0 做 docs-only 窄范围豁免：完整披露基线失败，不修改无关仓库资产；reviewer 如认为任一失败与本 diff 有因果关系，应直接退回。

### 根目录工件闸门

PASS：没有根目录媒体 / 设计工件。

### 相关文档

- `docs/design/teamact-v2-paradigm.md`
- `docs/design/teamact-v2-tech-article.md`
- `docs/design/teamact-v2-gap-migration.md`

[砚砚/gpt-5.6-sol🐾]
