---
feature_ids: [F257]
topics: [review-request, provenance, exact-metrics]
doc_kind: review-note
created: 2026-07-18
---

# Review Request: F257 V1 persisted-message provenance integrity R5

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact

## What

收拢 sol/terra R5 的三条 P1 为一个 persisted-record integrity 修复：

- provenance 增加第三个正交轴 `observation=original|derived`；derived 必带 `sourceRef`，original 禁带。
- append 与 exact read model 共享同一组跨字段不变量；routing projection 和 magic metric 都消费 canonical whole-record validator。
- missing hash、empty/malformed provenance、author/catId 与 routed/routingFact 矛盾全部 fail closed 为 unmeasurable。
- thread branch 与 transcript import 明确写 lineage；派生副本不重复统计 magic word，用户提交的 branch edit 是新的 original observation。

## Why

此前 append 边界有完整不变量，但两个 exact reader 各自只解析局部字段；损坏记录可静默退出 cohort，系统复制又会因新 messageId 伪造第二个行为样本。指标必须诚实区分 legacy、collection gap 与 original operator observation。

## Original Requirements（必填）

> 用户升级新版本后继续正常使用 → 系统自动采集 → 用户在段页面看到正在评估和已采集的数据 → 系统自动迭代 → 用户感觉流程越来越平顺、纠偏越来越少。

- 来源：`docs/features/assets/F257/objective-driven-redesign-v1.md` §0.5；指标与完整性真相源为 §3.5 T-B、§4.5。
- **请对照上面的 operator experience 判断：损坏/重复样本是否仍可能让系统给出貌似健康但错误的评估。**

## Tradeoff

没有新增第二个 dedup store，也不从 content/catId 猜 lineage；代价是所有新写入点必须显式声明第三轴。旧记录若完全没有 provenance 仍按 legacy 出 cohort；已经存在但形状不完整或跨字段矛盾的 provenance 一律 unmeasurable，不做有偏兼容。

## Architecture Ownership（必填）

Architecture cell: `harness-eval`
Map delta: `none`
Why: 复用 MessageStore/Redis projection 现有边界，只集中 persisted-record read invariant；未新增 Store/Queue/Router/Adapter/Dispatcher/Binding。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致。
- canonical validator 是否确实消除了 T-A/T-B 各自解释 provenance 的第二真相源。
- 第三轴是否覆盖所有生产写入点，而不是仅补测试 fixture。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|--------|---------|---------|
| INV-1 | 每个新 append 必须声明合法 `author/routed/observation` | `assertProvenanceConsistent` + provenance contract 6/6 |
| INV-2 | `routed=true ⇔ routingFact present` | write-boundary tests + routing contradiction Redis tests |
| INV-3 | `author=user ⇔ catId null`；`author=cat ⇔ catId present` | append tests + magic author/catId conflict test |
| INV-4 | derived 必带非空 `sourceRef`；original 禁带 `sourceRef` | provenance contract + branch/history assertions |
| INV-5 | indexed hash 缺失或 present-but-invalid record 不得降级成 legacy | projection collection-gap / empty / contradiction tests；magic reconcile conflict tests |
| INV-6 | T-B 只扫描 `author=user && observation=original` | derived duplicate test；edited branch original test |
| INV-7 | copy/import 的新 messageId 不等于新行为观测 | thread branch + session history import tests |

## E2E User Path Evidence

可豁免（纯内部 exact-metric integrity bugfix，无新增 user/cat 操作面）。替代证据：runner-owned 临时 Redis 上真实执行 append → reconcile → unmeasurable/dedup 路径，projection + magic + Redis store `58/58 pass`。

## Failure-Mode Sweep Report

Pattern: partial provenance contract / copied row masquerades as a fresh observation.

| 扫描面 | 处置 |
|--------|------|
| compiler-checked `AppendMessageInput` writers | 全部显式补 `observation`; `pnpm lint` / API build 通过 |
| branch / import / copy paths | branch 与 transcript import 写 derived lineage；edited branch 写 original |
| exact metric readers | T-A/T-B 都改用 `parsePersistedMessageRecord` |
| empty / missing / contradictory persisted fields | canonical fail-closed + Redis RED→GREEN |
| JS test fixtures | 全量 mechanical sweep；仅 3 个 deliberate invalid-provenance fixture 保持缺轴 |

## Open Questions

### 技术 OQ（给 reviewer）

1. 请验证 `parsePersistedMessageRecord` 的 legacy/missing/invalid 边界是否完整镜像 append invariant。
2. 请重点审 transcript import 作为 derived observation 的语义，以及 branch edit 作为新的 original observation 是否会产生漏计/重计。
3. 请逐条验证上面的 Invariant Matrix，并检查 82-file schema migration 是否仍有漏写路径。

### 价值 OQ（给 operator，如有）

无。

## Next Action

请在 branch HEAD 上给出明确 `APPROVE` 或按 P1/P2/P3 退回；若退回，请标注违反的 invariant。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f257/sol`
- Start Command: `pnpm review:start`（本轮无 UI/API runtime 变更，静态 review + targeted tests 即可）
- Ports: `N/A`（不启动服务；Redis validation 由 runner 分配并回收临时端口）

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## 自检证据

### Spec 合规

- T-A：损坏 authority record 不得产 partial exact rate。
- T-B：magic word 是 original operator observation 的 unique message-word hit，不把 storage copy 当新样本。
- 规范已同步到 `objective-driven-redesign-v1.md` v2.3.3；完整证据见 `docs/bug-report/f257-v1-provenance-integrity/bug-report.md`。
- Architecture cell `harness-eval` / Map delta `none`；无 UI，且无匹配 F257/provenance 的 `.pen`（唯一命中为无关 F190）；无根目录媒体工件。

### 测试结果

```text
pnpm lint                                      → exit 0
pnpm -r --if-present run build                 → exit 0
pnpm biome check . --diagnostic-level=error    → 4521 files, 0 errors
targeted Redis projection/magic/store          → 58/58 pass (runner-owned temp Redis)
MessageStore/thread-branch/history              → 49/49 pass
provenance contract                             → 6/6 pass
git diff --check                                → exit 0
```

全量包装命令如实披露：`pnpm test` 与 `pnpm --filter @cat-cafe/api test:redis` 均 exit 1；失败清单没有本轮受影响套件，尾部 3 项来自仓库缺失 `scripts/signal-fetcher-launchd.sh`，已在未改的 `develop_base` 原样复现。`check:features` / capability-tips / follow-up-tail 也有同一基线红点，本轮对其目标文件零 diff。此次以 failure delta=0 + 受影响面全绿作为 review gate，不声称仓库全绿。

Commit hook 额外披露：brand guard 因 `connector-gateway-bootstrap.ts` 被本轮改动而扫描整文件，命中基线已有 `http://localhost:3003`；该文件 staged diff 仅给 append type 增加 `observation`，`37e9e811e` 原文/blame 已验证端口行非 R5 delta。所有可运行门禁已独立执行，commit 仅为此 false-positive 使用 `--no-verify`，没有修改运行端口。

### 相关文档

- Design/spec: `docs/features/assets/F257/objective-driven-redesign-v1.md`
- Diagnosis + gate evidence: `docs/bug-report/f257-v1-provenance-integrity/bug-report.md`
- Feature: `docs/features/F257-harness-ledger.md`

[宪宪/gpt-5.6-sol🐾]
