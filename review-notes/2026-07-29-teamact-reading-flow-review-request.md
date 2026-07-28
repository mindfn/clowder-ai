# Review Request: TeamAct 阅读层级与状态动画

Review-Target-ID: teamact-reading-flow-animations
Branch: docs/teamact-reading-flow-animations

## What

重排 TeamAct 范式文与技术文章的阅读层级，并增加三件视觉解释资产：

- paradigm 增加非线性阅读路线；扩写职责交接，把状态、职权、Attempt 与 fencing 放进同一张迁移表；将六条不变量从密集长段改为扫描式矩阵；
- article 将九条判断从连续文字墙改为四组机制，并配一张九点地图、两张 GIF 和一张记忆图；主文只保留行业分层，逐框架比较与模式映射移至附录；
- 新增“同一 WorkUnit 安全易主”和“消息 ACK / 工作责任双状态机”两张 GIF，并提交可复现生成脚本。

## Why

原稿虽然机制完整，但章节权重更像审计底稿：paradigm 的职责交接明显轻于上下文，六条不变量压在少数长行里；article 的九条核心判断连续铺陈、行业框架对照又占据主线较大篇幅。读者需要先理解状态与职权怎样变化，再查协议细节，而不是从文字密度猜重点。

## Original Requirements（必填）

> “大致看了下感觉 teamact-v2-paradigm.md和teamact-v2-tech-article中的各个章节的详略不够得当；然后我觉得你们为了说明某个概念状体变化职权转移甚至可以做一些gif动图”
>
> “还有比如teamact-v2-tech-article中提了九点但是全是纯文字；对读者理解有点困难吧”

- 来源：thread `thread_mruayc4owlyzazbx`，message `0001785256106404-002073-6a5a8f0e`
- 请 reviewer 直接按“第一次接触 TeamAct 的读者能否建立正确心智模型”判断，不只审内部术语一致性。

## Tradeoff

- 主线变短但没有删掉比较信息：逐框架表与模式映射下沉附录；
- 两张 GIF 合计约 451 KiB，换取状态变化可视化；生成依赖 Chrome、ffmpeg、gifsicle，成品浏览不需要这些工具；
- paradigm §6 从约 1,980 字符扩到 3,652，§7 从约 2,048 字符的密集长段压到 1,677；article §5 从约 4,868 压到 1,549，§7 从约 1,555 扩到 2,080。

## Architecture Ownership（必填）

Architecture cell: coordination semantics / publication structure
Map delta: none
Why: 只改变设计文叙事、公开文章结构和解释性媒体，不改变运行时 Store / Queue / Router / Dispatcher / Binding。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|---|---|---|
| INV-1 | handoff 关闭当前 WorkUnit 并创建后继；transfer 保留同一 WorkUnit、迁移 custody | paradigm §6 表格与动图 1；article §3.2、Appendix B |
| INV-2 | transfer 需要授权 + 原子 CAS；取消、易主、新 Attempt 分别旋转 fencing token 的三个分量 | paradigm §6.2 / §7 N2；article 判断④；动图 1 |
| INV-3 | `created → … → processed` 与 `obligation → … → Outcome` 是两条状态机；ACK 不等于 Claim / fulfilled | paradigm §4.4；article 判断⑦；动图 2 |
| INV-4 | article 的九点地图与正文四组编号、含义完全一致 | Figure C 与 §3.1–§3.4 逐项对照 |
| INV-5 | 主文对外概念化；内部实现坐标、Feature / thread 证据只存在 frontmatter 或 review packet | 全文人工阅读与术语扫描 |

## E2E User Path Evidence

文档路径按读者顺序走查：

1. article Figure C 先给九点地图；
2. 判断④紧邻易主动图，判断⑦紧邻 ACK / 责任动图，判断⑧与上下文双通道图相邻，判断⑨与记忆图相邻；
3. paradigm Abstract 给阅读路线，§6 动图之后立刻给事件/职权/Attempt/安全边界表；
4. 两张 GIF 均以 1200×675 原尺寸检查首帧与中后段，无裁切、重叠或不可读文字；Figure C 以 1600×960 渲染目检。

## Open Questions

1. 主线与参考层的权重是否已经合理，还是仍有章节抢占核心叙事？
2. 两张 GIF 是否准确区分“状态变化”“职权变化”和“消息消费”，是否存在暗示错误的逐帧关系？
3. 九点的四组结构是否比原来的顺序更易懂，Figure C 与正文是否还有分组冲突？
4. article 主文是否仍有不适合公开读者的内部术语密度或实现泄漏？

## Next Action

请 Fable 对提交 HEAD 做跨家族正式 review，给出明确 `APPROVE` 或 P1/P2/P3 findings；重点审阅读层级与视觉语义，而非只做 Markdown 格式检查。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/teamact-reading-flow-animations/Fable`
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
pnpm exec biome check render-animations.mjs                PASS（0 warning）
node --check render-animations.mjs                          PASS
node render-animations.mjs                                  PASS
xmllint --noout figure-c-nine-judgments.svg                PASS
Markdown image reference resolution                         PASS
git diff --check                                             PASS
Root Artifact Guard                                          PASS

animation-custody-transfer.gif       1200×675, 13.5s, 308 KiB
animation-message-vs-responsibility  1200×675, 10.5s, 143 KiB
```

未跑应用 build / runtime E2E：本 diff 只含 Markdown、SVG、GIF 与离线媒体生成器，不改变应用构建图或运行时行为；完整仓库静态门禁 `pnpm check` 已通过。

[砚砚/gpt-5.6-sol🐾]
