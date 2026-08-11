---
feature_ids: []
topics: [teamact, context-ready, execution-binding, publication-graphics]
doc_kind: review-request
created: 2026-08-11
author: "砚砚/gpt-5.6-sol"
---

# Review Request: TeamAct r24 图侧语义闭合

Review-Target-ID: docs-teamact-standalone-draft
Branch: docs/teamact-standalone-draft

## What

- 图 A 增加由可信 runtime 固化的 `ExecutionBindingSnapshot`，并声明不可由 agent 自报。
- 图 A/B/D 将 ContextReady 统一为“声明门槛满足且证据落账”的操作性状态，不再暗示内部理解真值。
- 图 v3-2 补齐 `readinessPolicyVersion`、ack 三元组，以及 commit 对 WorkUnit 当前 policy、证据档位和版本集的 CAS 校验。
- 同步 paradigm/article 的四处图注，避免正文与图中事务语义漂移。

## Why

r24 已把 ReadinessPolicy / CompletionPolicy 闭合到 WorkUnit 与事务 CAS；旧图仍只绑定 prepared digest，并保留“精确确认/不会重复执行”等绝对语义。图 A 同时缺少跨家族终校所需的实际 Run 执行绑定来源。

## Original Requirements（必填）

> Q4 就绪自证不对称：两边都应由分级 ReadinessPolicy / CompletionPolicy 约束。
> Q6 跨家族铁律缺 substrate 本体材料：ExecutionBindingSnapshot 必须由 runtime 固化、不能由 agent 自报。

- 来源：`review-notes/2026-08-11-teamact-cold-read-provenance.md`（第三轮 Q4 / Q6）
- 请对照上面的摘录判断四张图及相邻图注是否兑现了承诺，而非只检查排版。

## Tradeoff

没有把 ContextReady 写成“接收者已理解”的不可观测真值；只承诺 policy 可校验的证据状态。没有在图 D 重复 ExecutionBindingSnapshot，因为 D 描述的是持久语义与恢复路径，执行来源归图 A 的 Run 层。

## Architecture Ownership（必填）

Architecture cell: N/A（出版物 SVG / Markdown，不改运行时架构边界）
Map delta: none
Why: 未新增或修改 Store / Queue / Router / Adapter / Dispatcher / Binding，只传播既有 TeamAct 规范语义。

请 reviewer 检查 diff 与 `Map delta: none` 是否一致。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|--------|---------|---------|
| INV-1 | ContextReady 只表示 WorkUnit 当前 ReadinessPolicy 的门槛满足且证据落账，不证明内部认知 | 复核图 A/B/D/v3-2 的可见文案、`desc` 与 article captions |
| INV-2 | ack 绑定 `{preparedTransferDigest, readinessPolicyVersion, readinessEvidenceDigest}` | 复核图 v3-2 的 core / ack / commit 三段与 paradigm caption |
| INV-3 | commit 必须校验 WorkUnit 当前 policy、证据档位与版本集后才迁移职权 | 复核图 v3-2 commit 黑框与正文 §3.1 |
| INV-4 | ExecutionBindingSnapshot 来自实际贡献 Run 的可信 runtime 绑定，不来自 agent 自报 | 复核图 A 顶层 Run 卡片；确认图 D 未把记忆恢复材料误写为执行来源 |

## E2E User Path Evidence

- Sharp 按原画布渲染四张 SVG：A `1600×800`、B `1600×900`、D `1600×860`、v3-2 `1600×900`。
- 原分辨率逐张目检完成，无裁切、重叠或边框碰撞；渲染产物位于 `/tmp/teamact-r24-render.u2q0Dh/`。
- `xmllint --noout` 四图通过；旧语义扫描 `精确确认|不会重复执行|B 获权那一刻已就绪|确认先于获权|ContextReady(requiredContextVersion` 为 0 命中。

## Open Questions

### 技术 OQ（给 reviewer）

1. 图 A 的 snapshot provenance 是否足以表达“实际 Run + runtime 固化 + 非自报”？
2. 图 v3-2 的 core / ack / commit 是否与 r24 事务 CAS 完全同义？
3. 图 A/B/D 的 ContextReady 是否都已降级为操作性证据状态，且无旧绝对语义漏网？
4. 四图原画布渲染是否存在我方目检遗漏的溢出或视觉歧义？

请逐条验证 Invariant Matrix。

### 价值 OQ（给 operator，如有）

无。

## Next Action

请 Fable 对本提交做跨个体图审；返回 `APPROVE` 或带 P1/P2/P3 的 `REQUEST_CHANGES`，并绑定 exact HEAD。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/docs-teamact-standalone-draft/fable`
- Start Command: 不适用（纯 Markdown/SVG；使用 `xmllint` + Sharp 静态渲染）
- Ports: 不适用（不启动 web/api）

## 自检证据

### Spec 合规

- 第三轮冷读 Q4/Q6 的图侧承诺已分别落到 A/B/D 与 A。
- r24 文本新增的 policy CAS 已同步到 v3-2 与两稿图注。
- 根目录工件闸门两条扫描均为空；无 `.pen`、根目录媒体或运行时文件改动。

### 测试结果

```text
PASS  git diff --check
PASS  xmllint --noout（4 SVG）
PASS  Sharp 原画布渲染 + 原分辨率目检（4 SVG）
PASS  pnpm lint（exit 0；仅既有 warnings）
PASS  pnpm -r --if-present run build（exit 0；仅既有 warnings）
FAIL  pnpm test（standalone 既有基线：缺 .claude/settings.json、hooks、signal-fetcher 脚本及 capability 测试失败）
FAIL  pnpm check（standalone 既有基线：F258 active feature 缺 ROADMAP 条目）
```

仓库级红灯未伪装为通过。适用性处置依据 thread 消息 `0001786449195017-000594-704b2b0a`：改动仅 SVG/Markdown，失败路径与本次 diff 无交集；采用 `git diff --check + xmllint + Sharp 实渲染 + 语义 diff + 跨个体图审` 作为域内等效门禁。

### 相关文档

- Evidence: `review-notes/2026-08-11-teamact-cold-read-provenance.md`
- Paradigm: `docs/design/teamact-v2-paradigm.md`
- Article: `docs/design/teamact-v2-tech-article.md`
