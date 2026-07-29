---
title: "TeamAct v3 外发文章视觉资产语义审计"
doc_kind: review
feature_ids: []
topics: [teamact, multi-agent, publication, visual-assets]
created: 2026-07-29
updated: 2026-07-29
source_thread: thread_mruayc4owlyzazbx
reviewed_sha: 2b947ede57e517a73609ba9611248d4d2ca62a92
reviewer: "砚砚 / gpt-5.6-sol"
---

# TeamAct v3 外发文章视觉资产语义审计

审计对象：`docs/design/teamact-v2-tech-article.md` 引用的 4 张 SVG、2 张 GIF，以及 GIF 真相源 `render-animations.mjs`。

验证方式：

- SVG 以 Sharp 按 1600px 等比例渲染后目检；
- 两张 GIF 分别抽取全部 9 帧与 6 帧做 contact sheet，逐帧对照 paradigm v3 §2–§5；
- 对资产源文件和生成器扫描 `Claim / Attempt / Transition / token / 八步循环` 等 v2 术语；
- 对照 article 当前正文、图注与 paradigm frontmatter 的“v2 旧图已过时”声明。

## 结论

**Verdict：REQUEST CHANGES。** 无 P1；3 个 P2 在修正前阻断完整外发包。问题不是文件名陈旧，而是图仍在教授已被 v3 否决或降级的本体。

### P2-1｜4 张静态图仍以 v2 `Claim / Attempt / 八步循环` 为真相

| 资产 | 确定问题 | v3 修正方向 |
|---|---|---|
| `figure-a-two-layers.svg` | 责任层主链仍是 `WorkUnit → Claim → 协调账本`，漏掉 `ResponsibilityAssignment` 与 per-scope `AuthorityGrant` 的分离 | 改为 Actor / WorkUnit + 两个版本化关系 + CoordinationLedger；若版面只容一层，至少不能继续把 Claim 画成唯一责任本体 |
| `figure-c-nine-judgments.svg` | 写着“Claim 跨 Attempt 存续”“Claim、SLA…保持不变” | 改为 Assignment 跨 Run 存续；职责与 per-scope 职权分别版本化，转移是授权集 + 就绪 + 原子提交 |
| `figure-b-loop-context.svg` | `<desc>` 和画面仍宣称八步 TeamAct 回合：Wake / Inspect / Acquire Claim / Orient / Execute / Verify / Commit / Transition | paradigm 已把八步回合降为实现细化，规范循环是 `Bind → Act → Handoff/Resolve`，`suspend` 是循环外治理中断；该图必须重画或移除 |
| `figure-4-memory-model.svg` | 责任记忆仍列 `Offer / Claim / Attempt / Transition`，恢复路径依赖旧实体 | 改为 `ResponsibilityAssignment / AuthorityGrant / Run / Handoff`；恢复三源保持“快照或检查点 + 账本回放 + 知识/历史检索” |

建议同步改成语义化文件名，避免新旧同名继续误用：

- `figure-a-execution-vs-responsibility.svg`
- `figure-b-context-channels.svg`
- `figure-c-design-mechanisms.svg`
- `figure-d-memory-recovery.svg`

旧文件只有在全文、导航与引用扫描确认无引用后才能删除；本审计不授权删除。

### P2-2｜职责转移动图与 v3 的两个关系、四段凭据直接冲突

`animation-custody-transfer.gif` 及 `render-animations.mjs` 仍画：

- `Offer → Claim → 执行 → 失联 → 授权 → 接收 → 恢复 → 完成` 八步；
- 单一 `Claim holder`；
- 三段 token `⟨7, 3, 1⟩`；
- “Claim generation 与 Attempt generation 同时旋转”；
- 直接 `TransferOffer` 后 CAS 换 holder。

v3 已明确：

- 责任和职权是两个独立版本化关系；
- 每个 AuthorityGrant scope 由各自 holder 授权，执行者不能替人转走审批权；
- prepare 先冻结随迁 grant、定版上下文 digest、封存在途副作用，接收者 ack 后才原子 commit；
- 凭据为 `{workUnitId, authorityScope, authorityVersion, runGeneration}`；
- abort、失联恢复和 suspended 都有显式路径。

因此该 GIF 不能做字符串替换式更新。最小可信方案是文章直接复用已通过语义审查的 `figure-v3-2-handoff-transaction.svg`，把动图移出外发正文；若保留动画，则必须按 v3-2 事务逐帧重写，并更名为 `animation-responsibility-authority-transfer.gif`。

### P2-3｜消息 ACK 动图底部状态机仍混用不同本体

`animation-message-vs-responsibility.gif` 的上半部传输态
`created → enqueued → delivered → seen → processed` 可以保留；下半部仍写
`obligation → Offer → Claim → Attempt → Outcome`，把 WorkUnit、责任状态、Run 与产出混成一条状态机。

修正为两条真正独立的状态：

- 消息传输态：保留现有五态；
- `ResponsibilityAssignment`：`unassigned → offered → assigned(v) → transfer-pending / suspended → resolved`。

`Run` 应作为 assigned 期间可启动、结束、替换的执行实例另画注记，不再充当 Assignment 的后继状态。文件建议更名为 `animation-transport-vs-responsibility.gif`。

## 同轮正文机械问题

Article §4 的比较表连续出现两行完全相同的“agent 生命周期”。这不是视觉语义问题，但会直接出现在外发正文；修图同轮删除重复行。

## 验收

- [ ] `rg` 扫描外发 article 及其引用资产，不再出现本体意义上的 `Claim / Attempt / 八步 TeamAct 回合 / 三段 token`。
- [ ] 新图逐张按最终页面宽度渲染，无裁切、重叠或低对比文字。
- [ ] GIF 的每一帧与生成器源数据一致，重跑生成器得到 byte-stable 或视觉等价产物。
- [ ] 所有 article 本地引用存在；旧文件无引用后再另行决定是否清理。
- [ ] article §4 重复“agent 生命周期”行已删除。

[砚砚/gpt-5.6-sol🐾]
