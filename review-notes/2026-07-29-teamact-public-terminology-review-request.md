# Review Request: TeamAct 公开术语校准

Review-Target-ID: teamact-public-terminology
Branch: docs/teamact-public-terminology

## What

对 TeamAct 三份文档和全部关联视觉资产做公开术语校准：

- 在 paradigm 中新增“失效状态与合法迁移的术语边界”，明确区分职责悬置、执行失联、职责失去有效承接、职责转移与顺序移交；
- 将 article 的五类失效、九条判断、适用判据与局限统一到这组公开术语；
- 同步 gap 的现状映射、差距矩阵和迁移路径；只在指向真实实现坐标时保留 `hold_ball`、`ball-custody` 等代码标识符，并紧邻解释其公开含义；
- 同步三张静态 SVG、职责转移动图的逐帧文字和可复现生成脚本，重新生成 GIF。

## Why

原稿将团队内部协作隐喻直接写进了范式和公开文章。内部成员能依赖共同背景补全含义，外部读者却无法判断它究竟指义务超时、执行者失联，还是一次合法的承担者变更。更严重的是，故障状态与合法迁移共用同一套隐喻，会模糊协议边界。

## Original Requirement（必填）

> “完注意到你们还在写 掉球语义 这种明显的内部风格的用语；这个应该其实就是职责的转移 掉球就是 职责丢失 这种把；不要用我们内部语言去表述；这样子没人看的懂的”

- 来源：thread `thread_mruayc4owlyzazbx`，message `0001785289205167-002284-ce33832a`
- 请 reviewer 以“首次阅读者能否从术语本身判断状态和迁移是否合法”为核心标准，不只检查机械替词。

## Tradeoff

- 没有把所有场景压成单一“职责丢失”：保留三种失效状态，避免 SLA 超时、liveness 丢失和无有效承接路径被错误合并；
- `handoff` 与 `transfer` 继续保留为协议英文名，中文分别固定为“顺序移交”和“职责转移”；
- gap 是实现差距真相源，因此精确代码标识符不改名；公开含义在首次出现处解释，避免伪造实现坐标。

## Architecture Ownership（必填）

Architecture cell: coordination semantics / publication terminology
Map delta: none
Why: 只修正文档术语、解释性 SVG/GIF 与离线生成器，不改变运行时 Store / Queue / Router / Dispatcher / Binding。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|---|---|---|
| INV-1 | 失效状态与合法迁移不混用：前三者需要探测/恢复，后两者是协议允许的迁移 | paradigm §1.4；article §2 末段 |
| INV-2 | handoff 关闭当前 WorkUnit 并创建后继；transfer 保留同一 WorkUnit、授权并原子更换 Claim holder | paradigm §6.1–§6.2；article 判断④与 Appendix B |
| INV-3 | 执行失联由 Attempt 心跳、lease 与 SLA 判断，不从消息沉默或主观观感推断 | paradigm F5、§6.2、§6.3；article F5、判断③ |
| INV-4 | 公开正文与视觉资产不再使用内部球类隐喻；静态图、GIF 逐帧文字和正文术语一致 | 禁词扫描 + 三张 SVG 和 GIF 帧目检 |
| INV-5 | gap 仅把内部英文标识符保留为精确实现坐标，不将它们作为规范语义 | gap §1 映射表逐行核验 |

## E2E User Path Evidence

1. 新读者从 paradigm §1.2 的五类失效进入 §1.4，可先区分三类故障与两类合法迁移；
2. article 在五类失效后立即给出同一组定义，九条判断和适用判据沿用一致术语；
3. 职责转移动图依次展示 Attempt 失联、授权 Offer、原子接收、旧 token 失效与检查点恢复，没有把“工作状态变化”误画成“执行权自动变化”；
4. Figure B/C 和循环图以新术语渲染目检，无裁切、重叠或旧文案残留。

## Open Questions

1. 三类失效状态的边界是否足够互斥且可操作，尤其“职责悬置”与“职责失去有效承接”是否仍可能被读者混淆？
2. “职责转移”与“顺序移交”是否在全文保持同一语义，是否存在把同一 WorkUnit 的 holder 变更写成后继 WorkUnit 的位置？
3. gap 中保留的精确实现标识符是否都满足“真相源坐标”豁免，还是有可以进一步公开化的叙述？
4. 三张静态图与职责转移动图是否仍有任何只有内部成员才能理解的短语？

## Next Action

请 Fable 对提交 HEAD 做跨家族正式 review，给出明确 `APPROVE` 或 P1/P2/P3 findings；重点审术语边界、协议语义和视觉逐帧含义。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/teamact-public-terminology/Fable`
- Start Command: 不适用（docs / media only；检出 detached HEAD）
- Ports: `web=N/A`, `api=N/A`

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
```

## 自检证据

```text
env -u NODE_ENV pnpm install --frozen-lockfile             PASS
pnpm check                                                  PASS
pnpm lint                                                   PASS（既有 advisory warnings）
pnpm exec biome check render-animations.mjs                PASS（0 warning）
node --check render-animations.mjs                          PASS
xmllint --noout 3 SVGs                                     PASS
Markdown local reference resolution                         PASS
TeamAct public terminology ban scan                         PASS（0 match）
gap G1–G18 matrix column validation                         PASS
git diff --check                                             PASS
Root Artifact Guard                                          PASS

animation-custody-transfer.gif       1200×675, 13.5s, 9 frames
animation-message-vs-responsibility  1200×675, 10.5s, 6 frames
```

未跑应用 build / runtime E2E：本 diff 只含 Markdown、SVG、GIF 与离线媒体生成器，不改变应用构建图或运行时行为；完整仓库静态门禁与 TypeScript lint 已通过。

[砚砚/gpt-5.6-sol🐾]
