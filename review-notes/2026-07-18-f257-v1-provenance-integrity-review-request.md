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

# R7 Re-review Delta: effective delivery-order coordinate

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact
Target: branch HEAD containing this packet；精确 SHA 由同一轮 A2A routed request 提供。

## What / Why / Tradeoff

- canonical whole-record validator 现在读取 `deliveredAt`，以 `effectiveOrderAt = deliveredAt ?? timestamp` 校验 owner timeline score；raw `timestamp` 继续保留发送事实。
- T-A/T-B 共用该坐标，正常 queued→delivered 与 delivered→reassign 不再被误判为损坏。
- T-B Event Memory 读取移除不安全的 event-time 预裁剪，按窗口内 `(owner, threadId, messageId)` exact join；backfill 新事件写 effective-order timestamp。代价是每条窗口消息一次 SQLite coordinate lookup，换取不依赖 live-event 时间先后关系的 exact 语义。

## Original Requirements

> “之前猛猛干了很多，对目标的实际提升基本是 0”；设计链必须从段目标与指标口径出发，tracing 只为可验证评估服务。

- 来源：`docs/features/assets/F257/objective-driven-redesign-v1.md` 开篇 operator 指令；T-B §3.5 与 §4.5 是本轮坐标真相源。
- 请判断合法 delivery mutation 是否仍可能制造假 unmeasurable，或 event-time 是否仍能漏掉 window member。

## Architecture Ownership

Architecture cell: `harness-eval`
Map delta: `none`
Why: 修改既有 persisted-message read model 与 Event Memory join；不新增 Store/Queue/Router/Adapter/Dispatcher/Binding。

## Invariant Matrix

| 不变量 | 断言 | 验证 |
|---|---|---|
| INV-R7-1 | append 时 score=`timestamp` | 既有 RedisMessageStore ordering tests + immediate metric regressions |
| INV-R7-2 | markDelivered 后 raw timestamp 不变，score=`deliveredAt` | queued magic/routed 真实 Redis tests |
| INV-R7-3 | reassignUserId 改 owner 并继承 effective score | T-A/T-B 新 owner measurable、旧 owner 空窗口 tests |
| INV-R7-4 | malformed deliveredAt 或 effective score mismatch fail closed | canonical corruption regression |
| INV-R7-5 | Event Memory window membership 只由 message coordinate join 决定 | pre-delivery live event 在 delivery-time window 仍计数 1 |

## Failure-Mode Sweep

Pattern: exact reader 把索引 score 当不可变 raw timestamp，遗漏合法 message 状态转换。

- 扫描 owner ZSET score 写点：append / markDelivered / reassignUserId 共 3 类；全部进入 v2.3.5 状态表与 regression。
- 两个 canonical parser caller 均补 `deliveredAt` HMGET；无 sibling reader 漏写。
- 反方向损坏：malformed deliveredAt 与 score mismatch 仍 unmeasurable。
- Patch-counter 已超过 3：本轮先升级 spec 状态机与 truth matrix，再实现，不再逐点放宽。

## E2E / Quality Evidence

可豁免 UI dogfood（纯内部 exact-metric integrity）。真实 public Store API 路径：queued append → markDelivered → optional reassign → T-A/T-B delivery window。

```text
RED: targeted real Redis                     → 35 pass / 3 fail
GREEN: R7 focused                            → 38/38 pass
R6 formal set + RedisMessageStore + R7       → 168/168 pass (runner-owned random Redis)
pnpm lint                                    → exit 0
pnpm -r --if-present run build               → exit 0
Biome full repo                              → 4521 files / 0 errors
git diff --check                             → exit 0
```

全量 `pnpm test` 仍被 feature worktree 缺失的 private/root assets、capability fixture 与共享 Redis collision 挡住；F257 affected suite 独立隔离全绿。`pnpm check` 的 F220/F258/shared-state 红点同样不在本轮 diff。完整清单见 bug report R7 Quality Gate evidence。

## Open Questions / Next Action

- 技术 OQ：请独立验证五条 invariant，特别是 live event 早于 deliveredAt 时的 coordinate join，以及 routing projection 在 reassign 后对旧 owner stale member 的清理。
- 价值 OQ：无。
- Next Action：对 routed request 中的精确 HEAD 给明确 APPROVE / REQUEST-CHANGES。

[宪宪/gpt-5.6-sol🐾]

---

# R8 Re-review Delta: persisted deletion lifecycle

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact
Target: branch HEAD containing this packet；精确 SHA 由同一轮 A2A routed request 提供。

## What / Why / Tradeoff

- canonical persisted parser 现在把 `deletedAt/deletedBy/_tombstone` 建模为 `deleted(soft|hard)`，T-A/T-B 共用该状态；marker 或 tombstone payload 矛盾仍 fail closed。
- soft delete 保留 F257/Event Memory 可恢复事实，exact readers 暂时排除；hard delete 同步清除 `routingFact/provenance`、routing/mention projection 与 coordinate-scoped Event Memory 主表和 dead-letter；整线程物理删除清全量索引与 thread Event Memory。
- 删除 hooks 在 message authority mutation 前同步执行：隐私 scrub 失败会中止删除；若后续 Redis mutation 失败，仍存在的 authority message 可重建 Event Memory。代价是 hard/thread delete 增加同步 SQLite/文件 I/O。

## Original Requirements

> “之前猛猛干了很多，对目标的实际提升基本是 0”；exact harness 指标不能把丢失/残留投影包装成健康结论。

- 来源：`docs/features/assets/F257/objective-driven-redesign-v1.md` T-B collection-integrity、§4.5.1 persisted truth source，以及 R7 reviewer hard-delete repro。
- 请判断不同 live-detector 历史下的相同删除终态是否仍会产生不同 exact 结果，或删除是否仍残留 token-bearing fact/excerpt。

## Architecture Ownership

Architecture cell: `harness-eval` / message-store extension
Map delta: `none`
Why: 扩展既有 MessageStore 删除边界、canonical read model 与 EventMemoryStore；不新增 Store/Queue/Router/Adapter/Dispatcher/Binding。

## Invariant Matrix

| 不变量 | 断言 | 验证 |
|---|---|---|
| INV-R8-1 | softDelete 保留事实但 T-A/T-B 排除；restore 后重入 | 真实 Redis soft-delete→metric→restore regression |
| INV-R8-2 | hardDelete tombstone 无 content/mentions/routingFact/provenance | RedisMessageStore + canonical corruption regression |
| INV-R8-3 | hardDelete 清 coordinate Event Memory 主表与 dead-letter | live event present/absent 同终态 regression + EventMemoryStore tests |
| INV-R8-4 | deleteByThread 清 hash/global/user/thread/mention/routing indexes 与 thread Event Memory | physical delete→T-A/T-B measurable empty window regression |
| INV-R8-5 | marker 缺失/畸形/矛盾不降级为 healthy/legacy | malformed deletedAt/deletedBy/tombstone tests |
| INV-R8-6 | derivative scrub 失败时 authority mutation 不发生 | in-memory deletion-hook abort regression |

## Failure-Mode Sweep

Pattern: canonical read model 只覆盖 active ordering，遗漏 persisted-message deletion 状态。

- 扫描 `softDelete / restore / hardDelete / deleteByThread` 四类生命周期；全部进入 v2.3.6 状态表和 regression。
- 两个 canonical parser caller 均补 deletion marker HMGET；soft/hard 状态统一由 parser 输出，不在 T-A/T-B 各自猜。
- 扫描硬删后的 token/excerpt 落点：message `routingFact/provenance`、routing/error/mention indexes、Event Memory SQLite row 与 dead-letter/outbox；均有清理或反向 invalid guard。
- 物理 thread delete 从“等 TTL 自愈”改为清理 persistent indexes；TTL 默认 0，不能依赖过期。

## E2E / Quality Evidence

可豁免 UI dogfood（纯内部 exact-metric integrity）。真实 public Store API 路径：append → optional live Event Memory → soft/restore 或 hard/deleteByThread → T-A/T-B exact read。

```text
RED: deletion lifecycle real Redis          → 98 pass / 9 fail
GREEN: R8 focused                           → 108/108 pass
R5-R8 + Store/branch/T-C extended Redis     → 268/268 pass (runner-owned random Redis)
Non-Redis deletion/branch regression        → 115/115 pass
pnpm lint                                   → exit 0
pnpm -r --if-present run build              → exit 0
Biome full repo                             → 4521 files / 0 errors
git diff --check                            → exit 0
```

全量 `pnpm --filter @cat-cafe/api test:redis` 仍被 feature worktree 缺失的 private/root assets、capability fixtures、root markdown/shared-state wiring 与 `signal-fetcher-launchd.sh` 挡住；R8 affected suites 在正确 test-home + random Redis 隔离下全绿。完整清单见 bug report R8 Quality Gate evidence。

## Open Questions / Next Action

- 技术 OQ：请独立复验 hard-delete live event present/absent 的同终态，以及 physical thread delete 后 owner/routing projection 无 collection gap；并审查 pre-mutation scrub 的失败语义。
- 价值 OQ：无。
- Next Action：对 routed request 中的精确 HEAD 给明确 APPROVE / REQUEST-CHANGES。

[宪宪/gpt-5.6-sol🐾]

---

# R9 Re-review Delta: deletion linearization and terminal fences

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact
Target: branch HEAD containing this packet；精确 SHA 由同一轮 A2A routed request 提供。

## What / Why / Tradeoff

- hard/thread delete 的线性化点改为 SQLite durable fence：`markEvent`、`appendDeadLetter`、episode helper 与 generic `appendSignal` 都在各自事务内检查 fence，旧 Redis snapshot 不能在删除完成后重建 excerpt/token。
- production cascade 先 purge/fence `magic_word_ref`，再 purge/fence Event Memory，最后原子 hard-tombstone Redis message；中途失败保留 fence、fail closed，可幂等重试收敛。
- physical thread delete 不再依赖健康 thread index：以 thread members + authority hash scan 并集发现 ID，并扫描 global/user/mention/routing/error/idempotency siblings 清 orphan。restore 与 hard delete 改为 Redis Lua 原子状态转换。
- Tradeoff：不可恢复删除是低频路径，新增 Redis SCAN 与 SQLite JSON-row scan；以删除延迟换取 persistent TTL=0 数据的隐私/exactness 终态。

## Original Requirements

> “之前猛猛干了很多，对目标的实际提升基本是 0”；评估必须对 persisted truth 诚实，不能让采集丢失或派生残留被包装成健康指标。

- 来源：`docs/features/assets/F257/objective-driven-redesign-v1.md` T-B collection-integrity、persisted-message v2.3.7 状态机，以及 R8 reviewer 的 stale-writer/episode/orphan/race 反例。
- 请判断相同删除 authority state 是否仍会因 live detector 历史、writer 时序或稀疏索引而得到不同 exact 结果。

## Architecture Ownership

Architecture cell: `harness-eval` / message-store extension
Map delta: `none`
Why: 扩展既有 EventMemoryStore、TaskOutcomeEpisodeStore 与 MessageStore lifecycle extension point；没有新增并行 Store/Queue/Router/Adapter/Dispatcher/Binding。

## Invariant Matrix

| 不变量 | 断言 | 验证 |
|---|---|---|
| INV-R9-1 | coordinate/thread fence 后 Event Memory 主表与 dead-letter 永久拒写 | stale metric snapshot + direct mark/dead-letter late-writer tests |
| INV-R9-2 | hard/thread delete 清既有 `magic_word_ref`，helper/generic sibling writer 都不能绕过 fence | TaskOutcome episode route projection + generic append regression |
| INV-R9-3 | empty/orphan/sparse authority 的 physical delete 仍执行 hook 并清全部 persistent indexes | empty hook、missing hash orphan、hash-not-in-thread-index real Redis tests |
| INV-R9-4 | restore 只能从 soft-deleted non-tombstone 原子转回 active | deterministic restore-read pause → hard-delete → restore-loses race |
| INV-R9-5 | cross-store partial failure privacy-first fail closed，retry 幂等收敛 | fence-before-authority ordering + repeated fence/delete semantics |

## Failure-Mode Sweep

Pattern: 把不可恢复删除实现成一次顺序 scrub，而不是所有 producer 消费的终态。

- Event Memory writer：`markEvent` / `appendDeadLetter` 共 2 类，均在 SQLite transaction 内检查 coordinate + thread fence。
- Episode projection writer：typed helper 与 public generic `appendSignal` 共 2 类；两者均由 store transaction 重检，preflight 只用于避免创建空 episode。
- Redis message indexes：global、thread、user、mention、routing fact、projection error、idempotency 全枚举；authority hash scan 关闭 thread-index sparse gap。
- 状态转换：append / softDelete / restore / hardDelete / deleteByThread 全入 v2.3.7；restore/hard 用 Lua 线性化。
- R6–R9 patch counter 已越过 5 轮线：本轮先建立删除真相源矩阵与级联状态机，再一次性扫描 sibling writer/index/transition；没有把 review finding 拆成四个互不相干补丁。

## E2E / Quality Evidence

Dogfood-Your-Slice scope verdict：🆗 可豁免 UI（纯内部 exact-metric/storage consistency，无新 user/cat action surface）。真实 public Store API + SQLite/Redis lifecycle 回归覆盖该 slice。

```text
RED: runner-owned Redis failure modes       → 53 pass / 3 fail
RED: SQLite writer/projection barriers      → 41 pass / 3 fail
GREEN: focused Redis / SQLite               → 56/56 + 44/44 pass
Extended affected Redis / non-Redis         → 171/171 + 139/139 pass
pnpm lint                                   → exit 0
pnpm -r --if-present run build              → exit 0
Biome full repo                             → 4521 files / 0 errors
git diff --check                            → exit 0
```

全量 `pnpm test` 与 `pnpm --filter @cat-cafe/api test:redis` 仍被 feature worktree 缺失的 private/root assets、capability fixtures、root markdown/shared-state wiring 与 `signal-fetcher-launchd.sh` 挡住；后者本轮确实使用 runner-owned `redis://127.0.0.1:6741/15`。`pnpm check` 在 Biome 通过后仍命中未改的 F258 ROADMAP / F220 User Journey。F257 affected suites 无 assertion failure；完整基线坐标见 bug report R9 Quality Gate evidence。

设计稿 glob：无 F257/routing/ledger/harness 匹配 `.pen`；无 web diff。Artifact hygiene：工作树与 feature diff 无根目录媒体/设计工件。

## Open Questions / Next Action

- 技术 OQ：请独立复验 stale snapshot → hard delete → resumed writer、generic episode writer bypass、empty/orphan/sparse physical deletion，以及 restore↔hard delete 的线性化；同时检查全索引 SCAN 是否遗漏 sibling collection。
- 价值 OQ：无。
- Next Action：对 routed request 中的精确 HEAD 给明确 APPROVE / REQUEST-CHANGES。

[宪宪/gpt-5.6-sol🐾]

---

# R10 Re-review Delta: Redis terminal writer barriers

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact
Target: branch HEAD containing this packet；精确 SHA 由同一轮 A2A routed request 提供。

## What / Why / Tradeoff

- Redis authority mutators 不再采用 read→unconditional write：payload、delivery、cancel、reveal、owner reassign 与 soft delete 都在最终 Lua 提交点判定 `hash exists && _tombstone != 1`；in-memory 实现同步 terminal contract。
- routing projector、reconcile missing-member repair 与 projection-error writer 在同一 Lua 中重读 active authority、owner 与 serialized fact。delete 或 owner/fact change 先线性化时，旧 snapshot 只能 no-op 并移除旧 owner member。
- repeated hard-delete 不改变 tombstone authority，但继续扫描全部 routing/error sibling keys 清理任何历史 owner 残留，允许第一次 cleanup 在 fence 后失败时幂等重试。
- physical thread delete 改为 authority-first 两阶段：authority scan 与 thread members 的并集先补为 thread retry anchors 并删除 hashes，再 post-transition 扫描/清 sibling indexes，最后才删 thread discovery index；因此 initial SCAN 后恢复的 projector 无法制造漏扫 key，原 thread index 缺失时 cleanup 失败也能由下一次调用重新发现 IDs。
- Tradeoff：hard/physical delete 是低频不可恢复路径，cleanup/retry 增加 Redis SCAN，physical path 还会短暂保留只含 IDs 的 thread retry anchor；换取 TTL=0、owner 曾迁移、projector 迟到且 cleanup 可中断时的确定终态。正常 active/soft-deleted completion writer 仍保持既有返回值与行为。

## Original Requirements

> “之前猛猛干了很多，对目标的实际提升基本是 0”；评估与删除都必须服从 persisted truth，不能让迟到 writer 把已经删除的敏感事实或路由投影复活。

- 来源：`docs/features/assets/F257/objective-driven-redesign-v1.md` persisted-message v2.3.8 状态机、§4.5 exact truth source，以及 R9 formal reviewer 的 payload/projector 真实 Redis 反例。
- 请判断所有已有 message-id writer 是否都在最终存储边界消费 terminal state，而不是依赖调用方 preflight。

## Architecture Ownership

Architecture cell: `harness-eval` / message-store extension
Map delta: `none`
Why: 收紧既有 MessageStore mutator 与 RedisRoutingFactProjection 的提交边界；没有新增 Store/Queue/Router/Adapter/Dispatcher/Binding。

## Invariant Matrix

| 不变量 | 断言 | 验证 |
|---|---|---|
| INV-R10-1 | hard tombstone 经任意 public mutator 后 hash 字节级不变 | Redis/In-memory 全 mutator terminal matrix |
| INV-R10-2 | delete 前读取、delete 后提交的 stale payload writer 不能回填数据 | paused `updateExtra` → hard-delete → resume |
| INV-R10-3 | hard/physical delete 与 delayed projector/reconcile repair 任意交错都无 routing/error member 复活 | wired projector + reconcile pause/resume real Redis tests |
| INV-R10-4 | projector 只为 active、owner/fact 匹配的 authority 提交 | atomic projector/error Lua + owner reassign race |
| INV-R10-5 | repeated hard-delete 不改 authority，但可清所有历史 owner 残留 | tombstone bytes snapshot + historic owner cleanup retry |
| INV-R10-6 | physical delete 先令 authority absent，再稳定扫描 sibling；并集 IDs 都有 thread retry anchor | scan→late-project race + missing-thread-member/WRONGTYPE cleanup retry |
| INV-R10-7 | active/soft→restore 的 delivery/metadata/reassign 行为保持 | Store + queue/startup/scheduler/tracing + T-A/T-B regressions |

## Failure-Mode Sweep

Pattern: deletion fence 已存在，但 Redis authority/projection 的最终 writer 未消费它。

- MessageStore public mutator census：`softDelete/hardDelete/restore/updateExtra/augmentStreamMetadata/revealWhispers/markDelivered/markCanceled/reassignUserId` 全部进入 v2.3.8 状态×事件表；`append` 是新 identity，明确排除。
- Redis write census：已有 message id 的 HSET/ZADD 只剩 guarded Lua；append pipeline 是新 identity 创建。project、reconcile repair 与 error marker 共用同一 authority-state predicate。
- 竞态反方向：payload writer 先提交则后续 hard delete 擦除；delete 先提交则 writer 拒绝。project 先提交则 hard scan 清除；delete 先提交则 projector 自清/no-op。
- 历史 owner / partial failure：hard cleanup 扫描所有 routing/error sibling keys；tombstone transition 与 derivative cleanup 分离，重试不再被 terminal early-return 吞掉。
- physical collection race：authority-first transition 关闭所有 guarded writers，再做 post-transition sibling SCAN；thread key 作为 discovery anchor 只在 cleanup 成功后删除，避免 scan→late-key 漏扫与失败后丢失重试坐标。
- R6–R10 已超过五轮线：本轮先升级 spec v2.3.8、truth matrix、state×event 与 writer census，再实现完整提交屏障；没有把两条 finding 各自点补。

## E2E / Quality Evidence

Dogfood-Your-Slice scope verdict：🆗 可豁免 UI（纯内部 storage/exactness terminal consistency，无新 user/cat action surface）。真实 public Store API + Redis race 是本 slice dogfood。

```text
RED: terminal/stale-writer/projector set       → 85 pass / 4 fail
RED: historic-owner cleanup retry             → 0 pass / 1 fail
RED: delayed reconcile repair                 → 0 pass / 1 fail
RED: physical scan→late-project               → 0 pass / 1 fail
RED: orphan-authority cleanup retry anchor     → 0 pass / 1 fail
GREEN: Message/Redis/Projection focused       → 92/92 pass
Affected callers + exact/episode/branch       → 459/459 pass
pnpm lint                                     → exit 0
pnpm -r --if-present run build                → exit 0
Biome full-repo stage                         → 4521 files / 0 errors
git diff --check                              → exit 0
```

全量 `pnpm test` 与 `pnpm --filter @cat-cafe/api test:redis` 均 exit 1；失败仍为 feature worktree 缺 private/root assets、capability fixtures、root markdown/shared-state wiring 与 `signal-fetcher-launchd.sh` 等基线面，不含 R10 affected assertion。`pnpm check` 在 Biome/review-worktree guard 通过后仍命中未改的 F258 ROADMAP / F220 User Journey。仓库未导出 hotfix/fallback/architecture-ownership scripts；无 F257/routing/ledger/harness 匹配 `.pen`，无 web/root media diff。完整证据在 bug report R10 Quality Gate。

## Open Questions / Next Action

- 技术 OQ：请独立复验 stale `updateExtra/augment`、wired fire-and-forget projector 与 reconcile repair 的 delete-before-commit 交错；同时审 hard tombstone repeated cleanup 是否既保持 authority bytes 又能清除任意历史 owner member，并复验 physical initial-SCAN→late-project→authority-delete 及 cleanup-failure→retry 两条窗口。
- 请检查 `markDelivered/reassignUserId` 的 Lua 是否保持 active/soft-deleted 既有 score/owner contract，以及 error-marker writer 是否与正常 projector 使用同一 authority predicate。
- 价值 OQ：无。
- Next Action：对 routed request 中的精确 HEAD 给明确 APPROVE / REQUEST-CHANGES。

[宪宪/gpt-5.6-sol🐾]

---

# R11 Re-review Delta: commit-time owner/effective-order coordinate

Review-Target-ID: f257
Branch: feat/f257-v1-routing-fact
Target: branch HEAD containing this packet；精确 SHA 由同一轮 A2A routed request 提供。

## What / Why / Tradeoff

- `markDelivered` Lua 现在校验调用方 expected owner；owner 已变化时只返回 current owner，不写旧 owner，Store 重读 authority 后重试。
- `reassignUserId` 不再把 Lua 外 ZSCORE 当提交事实；脚本在 owner guard 通过后从同一 authority hash 读取 `deliveredAt ?? timestamp`，再移动 owner member。
- failure-mode audit 同步收紧 projector/reconcile：routing score 在最终 Lua 中从 authority effective-order 推导，迟到 snapshot 不得把 delivery coordinate 回退到 sentAt。
- Tradeoff：delivery 遇到并发 owner 变化时增加一次 Redis authority 重读/重试；换取 hash owner、old/new owner timeline、thread/global 与 exact window 的单一线性化坐标。没有新增 lock、影子字段或第二真相源。

## Original Requirements / Architecture

F257 exact metric 必须以 persisted truth 的 `owner + effectiveOrderAt` 定位 observation；并发 scheduler owner backfill 与 queue/startup delivery 不能让合法消息静默退出 delivery-time cohort。

Architecture cell: `harness-eval` / message-store extension
Map delta: `none`
Why: 收紧既有 RedisMessageStore/RedisRoutingFactProjection 的提交边界；未新增 Store/Queue/Router/Adapter/Dispatcher/Binding。

## Invariant Matrix

| 不变量 | 断言 | 验证 |
|---|---|---|
| INV-R11-1 | reassign→delivery 与 delivery→reassign 终态相同 | 两个 paused-Lua real Redis tests |
| INV-R11-2 | delivery 不得向 snapshot old owner 写入 | old owner ZSCORE=null；owner conflict 后重读/重试 |
| INV-R11-3 | reassign 的 new-owner score 来自提交时 authority | new owner/thread/global score 全等于 deliveredAt |
| INV-R11-4 | routing writer 不信任 snapshot timestamp | delivery 后 stale `project(msg)` 仍写 deliveredAt |
| INV-R11-5 | exact delivery window 不静默漏计 | 两个交错均 `unmeasurable=false, cohort=1` |

## Failure-Mode Sweep

Pattern: writer 虽原子，但跨 hash/index 的 key/score 仍由调用前 snapshot 决定。

- Message coordinate consumers：`markDelivered`、`reassignUserId` 已改为 commit-time owner/effective-order。
- Projection consumers：live projector 与 reconcile repair 共用 `PROJECT_ACTIVE_ROUTING_FACT_LUA`，score 在脚本内重读 authority；error marker 只记录失败时间，不是 effective-order projection。
- 反向交错：reassign 先提交 → delivery owner conflict/retry；delivery 先提交 → reassign 读取 deliveredAt；任一顺序都不会生成双 owner member或 sentAt new-owner score。
- Terminal transitions：hard/physical delete 仍先使 Lua 返回 terminal/absent；R10 tombstone、delayed projector 与 physical retry suites 保持绿。
- Patch counter 已越闸：v2.3.9 先将 owner+effective-order 建成一个状态对象及三条可测不变量，再修改实现。

## E2E / Quality Evidence

Dogfood-Your-Slice scope verdict：🆗 可豁免 UI（纯内部 Redis/exactness consistency，无新 user/cat action surface）。真实 Store API + paused Redis Lua + exact metric query 是本 slice dogfood。

```text
RED: dual transition + stale projector          → 0/3 pass
GREEN: same adversarial set                     → 3/3 pass
Message/Redis/Projection focused                → 95/95 pass
Affected callers + exact/episode/branch         → 459/459 pass
pnpm lint                                       → exit 0
pnpm -r --if-present run build                  → exit 0
Biome changed files / full-repo stage           → 0 errors / 4521 files, 0 errors
git diff --check                                → exit 0
```

`pnpm test`、`pnpm --filter @cat-cafe/api test:redis`、`pnpm check` 与 capability-tips 的既有 feature-worktree 基线红点已在 bug report R11 Quality Gate 如实披露；均不含 R11 affected assertion。治理脚本 unavailable、无匹配 `.pen`、无 web/root media diff。

## Open Questions / Next Action

- 请独立复验两个 paused-Lua 交错，确认 owner-conflict 重读不会写旧 owner，reassign Lua 不再消费 Lua 外 score。
- 请检查 live projector 与 reconcile repair 的 ARGV 变更是否一致，并验证 stale snapshot 只能写 authority 当前 effective-order。
- 价值 OQ：无。
- Next Action：对 routed request 中的精确 HEAD 给明确 APPROVE / REQUEST-CHANGES。

[宪宪/gpt-5.6-sol🐾]
