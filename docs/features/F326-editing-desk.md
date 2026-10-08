---
tips_exempt: "2026-10-10: Phase A provides versioned timeline/data contracts, not an editing interface or renderer; its architecture and acceptance record adds no user-invokable action. Later editing journeys need their own implemented entry before discovery tips advertise them."
feature_ids: [F326]
related_features: [F138, F202, F205, F309, F322, F307]
topics: [video, editing-desk, review, animation, promo-video, remotion-plugin, workbench, check-pages]
doc_kind: spec
created: 2026-10-07
description: "人和猫一起做片子的剪辑台：审片只提异议、镜头表改剪辑输入、设定与检查页、导出；渲染引擎只在插件里，动画和宣传片共用一条时间线。"
description_source: human
description_author: opus55
description_updated_at: 2026-10-08T02:10:00Z
---

# F326: Editing Desk｜剪辑台

> **Status**: in-progress | **Owner**: Ragdoll (@opus55, design owner) · 架构 小星星 (@codex-astra) · 执行 小太阳 (@codex61-sol) | **Priority**: P1

Architecture cell: `collaborative-content-plane`, `plugin`

Map delta: Phase A 在 F138 content/revision/CAS owner 内增加通用 video-project 合同与不可变访问 scope；审片经过复用 F309 canonical ledgers，素材复用索引边界；Remotion 数据互转留在插件侧。

Why: 让剪辑输入、检查页与待决定共用一份可恢复的项目真相，保留审片经过，避免另建项目或审片 Store。

## Why

> 「… 剪辑台 … 素材的收纳 … 以这一个处处喵的这个片子为一个打样 … 这个是我觉得现在我们已经可以开工的那条线了。」
> — You，2026-10-06 22:03 PDT（`[thread-id]#private-source-id`）

> 「我现在都是quicktime看的，因为家里的chat里的富文本vedio的渲染 不能让我拉动进度条 … 那个能看片的对人而言挺重要的」「我应该反馈的只有哪张不同意，不应该反馈同意！要反过来」
> — You，2026-10-07（`[thread-id]#private-source-id`）

醋醋喵 EP0 是在聊天里、文件夹里和 Remotion 代码里拼出来的：You 看片要切到 QuickTime，提意见只能在聊天里说一句，猫要自己去找是哪一张；100 个镜头、几百张画稿、配音和检查图散在三个地方，谁审过什么只有聊天记录知道。剪辑台要让 You 在家里直接看片、只标不同意的地方，让猫在同一处改镜头、对设定、出检查图、导出，而且下一部片子（宣传片、别的动画）也能用同一套。

## Current State / 现状基线

- **没有剪辑台**：`packages/web` 里没有时间线、镜头表、审片或导出界面（Studio 北极星 §1.6 的核对，2026-10-02；本次未重新普查）。
- **看片**：聊天里的视频用 `/api/workspace/file/raw` 发出，这个路由不处理 Range、超过约 10MB 拒绝（`packages/api/src/routes/workspace.ts` 563 行一带），EP0 只能切成 5 段发、1080p 成片在 Finder 里交付。修复已在 F322 C 线（Sol6.1，subject `workspace:raw-media-range`），是否就是 You 拖不动的全部原因仍待真页复现。
- **相邻的现有 Feature**：F138 Video Studio 是视频制作管线（项目、素材、revision、渲染、发布的 owner 语义），Phase 0 明写「不做自定义 timeline/editor（Remotion Studio 已够用）」；F205 是视频生成 / 分析的 provider 插件。剪辑台是人和猫一起用的工作台，覆盖 F138 没覆盖的动画线，也需要 F138 当时排除的编辑界面。两者数据怎么分工见 OQ-1。

## What

五块界面：**审片**（You 的第一屏）、**镜头**（猫改剪辑输入）、**设定**（角色、场景、道具、声音、待决定）、**画稿**（按场看画稿 + 检查页）、**导出**。

### Phase A: 架构与数据合同（已完成：小星星架构、小太阳实现）

合入后的隔离 Alpha `f326-phase-a`，HEAD `716575552d675facf243a3ee0f16dfcf8a940137`（包含上述 merge），两片 JSON 的保存与新 owner 实例恢复、CAS/权限、决定含义、检查结果与审片定位历史检查 38/38 通过；日志 `/tmp/f326-alpha-data-contract.log`。本阶段交付数据基础，尚无剪辑台界面、影片解码或渲染；验收时 live runtime 尚未加载本次 merge，后续真实产品旅程仍按 Phase B–D 推进。

把剪辑台要用的数据落到正确的 owner 上，不另起一套账：
- 一部片子 = 一条通用时间线：一段段（镜头 / 节拍），从哪开始、多长、用了哪些素材；一个镜头可以有几张画稿。剪辑台改的是剪辑输入，不碰生成出来的产物（logic.md 第二版）。
- 素材按种类认（图、视频、录屏、配音、配乐、音效、字幕、文字稿、重画的界面），每件记着被哪部片子的哪一段用了；先给现有文件建索引，不搬家（复盘「还没定的」第一条，待架构确认）。
- 审片意见：锚在这一刻 / 这个镜头 / 全片，可带画面区域；经过可追（谁提、谁定位、谁改、结果）。
- 检查页：人和猫都能新建；名称、看什么、对照哪几张参考图、用在哪些场次、谁来做、由来。每场按检查页出图。
- 版本：人改的是草稿，存了才是新版本；猫的修改是基于某一版的候选；导出单独执行（Studio 北极星 10-02 那几条）。
- 渲染引擎只在插件里：主仓不依赖 Remotion；Remotion 插件负责合成 ↔ 时间线互转和渲染（F202 插件框架）。

### Phase B: 审片（第一刀，在真实产品壳里）

You 从 Workspace 打开一部片子：看片（可拖、可跳）、只标不同意的地方、看猫的修改、对比版本。用 EP0 的真数据。

**Phase B 审片一屏已完成：实现与设计返修已合入，隔离 Alpha 工程复验和Ragdoll真页设计复验均已通过，AC-B1–B5 已验收。** 架构 [#5341](https://github.com/zts212653/clowder-ai/pull/5341) 与实现 [#5357](https://github.com/zts212653/clowder-ai/pull/5357) 已合入，后者 merge 为 `b5c05e6201372bac4fcf5154c3c1c4df16b6ad39`。非作者完整批准覆盖 Host `798f43d329b27a40451a56e69a3025d29d63afe7`、本 spec 接受修订 `5e909cb13ddc17247ea98d100325c5aed277f5db`，无开放 P1/P2（`[thread-id]#private-source-id`）。

#### Phase B 验收闭环（2026-10-11 UTC）

| AC | 实际结果与凭据 |
|----|----------------|
| B1 | 真实 Workspace 默认入口进入审片，62,662,471 字节原片可鼠标拖动、逐帧与到 450 秒片尾；HTTP Range 206。见作者/Alpha实物与设计 r2。 |
| B2 | moment/range/shot/project/region 冻结位置进原 composer；原 Human 实际发送后通知负责猫并导入同一 canonical ledger，猫显式接管、真实 F138 CAS 修改与 F309 历史可恢复；原一次发送未重放。 |
| B3 | 自审与待决定数来自受授权的实际记录；本片诚实显示尚无自审、零待决定，不由 100 镜头或检查页推断，没有逐张同意按钮。 |
| B4 | 原画稿/实际改稿并排、同步缩放；原片出现时间由映射算出并实际定位 1429/30=47.633333 秒。未生成新成片时保留明确提示，仅回冻结原片；有可核验新成片才给新版目的地，沿接受来源641。 |
| B5 | 旧版在左、当前新版固定在右并同步播放，意见冻结在右侧所看的精确版本；右版切换清理不合法比较，解码等待/取消和混来源拒绝已回归。 |

### Phase C: 镜头、设定、画稿与检查页、导出

猫的工作面：镜头表（按场切换、状态只标例外、检查栏改这一格）、设定（待决定放检查栏）、画稿（检查页可新建）、导出（内部带水印 / 正式版、发到聊天或文件、记录）。

### Phase D: Remotion 插件与第二部片子

Remotion 插件接上 EP0 的真实合成；用一部宣传片（《平行世界》）跑同一条时间线，验证不是只为动画画的。

## User Journey

### Primary Journey: You 看一版片子，只标不同意的地方
- **Scope unit**: 一部片子的一个版本（例：醋醋喵 EP0 · v0 精绘与动效）
- **Actor**: operator
- **Entry**: Workspace 里打开这部片子的剪辑台，默认落在「审片」
- **Flow**:
  1. 顶栏写「猫已自审 100 个镜头」和「1 项待你决定」；大播放器放在中间，下面两层时间轴（全片九场概览 + 当前片段镜头条）。
  2. You 拖进度条、跳到片尾、逐帧、循环一个镜头，不用切到 QuickTime。
  3. 看到不对的地方按「标记问题」（M），先选挂在这一刻 / 这个镜头 / 全片，可在画面上框一块，写一句话，记下。说不清是哪一张就挂全片。
  4. 没标的地方都算通过；不需要逐张点「同意」。
  5. 猫定位、改好以后，问题栏这一条写「已修改」，下面是经过（You 提 → Ragdoll定位 → 小星星重画）；点「查看修改」看画稿对比（同步缩放），点「在影片中查看」跳到那张画真正出现的时刻继续播。还不对就点「还不对」。
  6. 待决定的事（例：Ragdoll的项圈）直接在问题栏里选。
- **Success evidence**: 真实入口的浏览器旅程（大于 10MB 的成片拖动 + 跳到片尾 + 标记一个问题 + 查看修改），截图与 Network 206 证据。
- **Non-goals**: 通用剪辑软件（关键帧曲线、多轨精剪、手调动效）；生图、配音、渲染本身（猫在 skill 和插件里做，台面只显示结果和开关）；剧本写作（只读、能跳转）；git / PR。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | 一个镜头 | 猫（导演 / 画师） | 镜头 → 选场次 → 点一格 → 检查栏改时长、画面版本、画面切换、溶接 / 震动 / 轻微起伏、字幕 → 生成预览 → 对比上一版 | 浏览器旅程 + 预览产物 |
| S2 | 一个检查页 | operator或猫 | 画稿 → 检查 → 新建 → 写名称、看什么、选参考图、用在哪些场次、谁来做 → 新建 → 每场出现这一页，没有图的场次可请画师补 | 浏览器旅程 + 持久化（TTL=0） |
| S3 | 一次导出 | 猫 | 导出 → 选版本、用途、范围、发到哪、分辨率 → 导出 → 记录里出现这一份（大小写数字） | 产物 + 记录 |
| S4 | 一个待决定 | operator | 设定或审片的问题栏 → 在选项里选一个 → 猫收到并按设定统一改 | 选择持久化 + 猫收到的消息 |

## Acceptance Criteria

<!-- 每条回到 Why：在家里看片、只提异议、猫在同一处干活、下一部片子能复用。 -->

### Phase A（架构与数据合同）
- [x] AC-A1: Design Gate 写出 `Architecture cell / Map delta / Why` 三行，并对 OQ-1 给出结论：剪辑台的片子、素材、版本是复用 F138 的 owner，还是有明确理由另立；不私造第二份项目真相。
- [x] AC-A2: 一份通用时间线合同能无损表示 EP0（`sbAnimaticCues.json` 的 100 个镜头、多画稿镜头、切换帧）和《平行世界》的节拍；用这两部片子的真实数据跑通往返（导入 → 读出一致）。
- [x] AC-A3: 审片意见（四种锚点 + 经过）、检查页（六个字段）、待决定都持久化（TTL=0），重启后原样恢复。
- [x] AC-A4: 主仓 `package.json` 依赖里没有 `remotion` / `@remotion/*`；Remotion 相关代码只在插件里（F202）。

### Phase B（审片）
- [x] AC-B1: 从 Workspace 真实入口（不带手输参数的默认入口）打开 EP0 的剪辑台，默认落在审片；大于 10MB 的成片能拖动、跳到片尾，Network 有 206。
- [x] AC-B2: 标记问题可选这一刻 / 这个镜头 / 全片，可框选画面区域；记下后出现在问题栏，负责的猫收到通知。
- [x] AC-B3: 顶栏「猫已自审 N 个镜头」「N 项待你决定」来自真实状态；没有逐张「同意」按钮。
- [x] AC-B4: 查看修改是画稿对比（并排、同步缩放）；「在影片中查看」跳到的时刻按渲染规则计算（EP0 的 C08c 是 0:47.6，不是镜头起点 0:45.3）。
- [x] AC-B5: 对比上一版：两版同步播放，新意见记在新版本上。

### Phase C（镜头、设定、画稿与检查页、导出）
- [ ] AC-C1: 镜头表可切场次；状态只标例外，配「全部 / 有说明 / 需修改」筛选；检查栏改的是剪辑输入，生成预览后能对比上一版。
- [ ] AC-C2: 检查页由人或猫新建（Supporting S2 全流程）；页签不写死，EP0 各场按真实登记显示（第三、四场只有脸和头顶，第八场有道具）。
- [ ] AC-C3: 待决定可以在设定或问题栏里直接选，选择持久化并通知负责的猫。
- [ ] AC-C4: 导出：内部审看带水印 / 正式版、发到聊天（超过上限自动分段）或文件、导出记录；文件大小写数字，只有正在导出的任务画进度条。

### Phase D（Remotion 插件与第二部片子）
- [ ] AC-D1: Remotion 插件把 EP0 的合成读成通用时间线、把剪辑台的改动写回合成，并能渲染预览；人和猫看到的是同一份数据。
- [ ] AC-D2: 《平行世界》用同一套剪辑台走完一轮：节拍表、审片标记一个问题、导出一份。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「… 剪辑台 … 素材的收纳 … 以这一个处处喵的这个片子为一个打样」 | AC-A2, AC-B1, AC-C1 | 真实入口浏览器旅程（EP0 数据） | [ ] |
| R2 | 「家里的chat里的富文本vedio的渲染 不能让我拉动进度条 … 那个能看片的对人而言挺重要的」 | AC-B1 | 大于 10MB 的 mp4 拖动 + 206 | [x] |
| R3 | 「我应该反馈的只有哪张不同意，不应该反馈同意！要反过来」 | AC-B2, AC-B3 | 浏览器旅程：无逐张同意按钮，标记一个问题 | [x] |
| R4 | 「我们下次换了一个项目 … 产品宣传视频。那么我们又需要什么东西呢？」 | AC-A2, AC-D2 | 《平行世界》往返与一轮审片 | [ ] |
| R5 | 「这个东西你要集成也得做成插件那个样子的去集成，你不能集成到主仓 会太臃肿」；「我们自己的mit 开源授权的 的开源项目」 | AC-A4, AC-D1 | 依赖检查 + 插件往返 | [ ] |
| R6 | 「有tab分页 是对的， 但是 我们不应该写死 而是这个页面允许用户（operator，猫猫） 自己定义新建很重要？不同的需要不一样的」 | AC-A3, AC-C2 | 浏览器旅程：新建检查页并持久化 | [ ] |
| R7 | 「制作视频的工作台都有色彩的问题，一个色 ui ux的文字也有问题」 | AC-B1–C4（设计稿对照） | 真实页面对照北极星 v4 与 DESIGN.md「制作工作台」 | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求有足以判断实际结果的依据

## Dependencies

- **Evolved from**: F309（Studio 北极星 §1.6 的视频剪辑器稿，2026-10-02 当时定为「另立」）
- **Dependency satisfied**: F322 C 线 raw 媒体 Range 修复 [#5243](https://github.com/zts212653/clowder-ai/pull/5243) 已合入（`9e064f5ae665e59b73fc7c61e26865411b3c7a20`）；Phase B 原片的实际 206、拖动和定位已验实。
- **Related**: F138（视频制作管线：项目 / 素材 / revision / 渲染的 owner，见 OQ-1）、F202（插件框架，Remotion 插件走这里）、F205（视频生成 / 分析 provider 插件）、F307（作品模式与整窗）、F322（Workspace 外壳与 v2 设计语言）

## Risk

| 风险 | 缓解 |
|------|------|
| 和 F138 各记一份项目 / 素材 / 版本，真相分叉 | Phase A 先答 OQ-1；F191 三行写清归属，不私造 Store |
| 拖不动的原因不止 raw 路由（播放器路径、publication 分支） | Phase B 以真实 Chat / Workspace 里的那支视频为准复现，F322 C 线的取证结果先读 |
| 北极星只是设计稿、没上手过，做出来才发现不好用 | You 已说小步快跑：Phase B 先交审片一屏，真页面上手后再改，不一次铺五屏 |
| Remotion 授权与主仓 MIT 冲突 | 只在插件里，由用户自己装；插件说明写清 Remotion 的条款 |
| 检查页、问题经过这类内容被界面替人或猫改写 | 名称和说明原样显示；用词规矩放在猫的 skill 里 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 审片只提异议：没标的都算通过，不给人逐张同意的按钮 | You 原话（R3）；EP0 实际是Ragdoll和小星星自审，You 只看不同意的 | 2026-10-07 |
| KD-2 | 渲染引擎只在插件里，主仓只认通用时间线 | You：Remotion 不能进主仓；主仓 MIT | 2026-10-07 |
| KD-3 | 检查页由人和猫自己新建，界面不写死分类 | You 纠正（R6）；品味记录 `4737511a4d` | 2026-10-07 |
| KD-4 | 设计以北极星 v4 为当前稿，小步快跑，上手后再改 | You 2026-10-07 18:44 PDT | 2026-10-07 |
| KD-5 | 分工：设计Ragdoll，架构小星星，执行小太阳；review 由Maine Coon自己定 | You 立项授权（`[thread-id]#private-source-id`）：「项目design owner是你，架构小星星，执行喵小太阳sol61 然后review什么的就让Maine Coon他们自己决定甚至可以小太阳自己喊自己的subagent 也选小太阳去re 都可以的」 | 2026-10-07 |

## Tips Contribution（F244）

Phase B 已加入 1 条：「审片只标不同意的地方，没标的都算通过」，指向 DESIGN.md「制作工作台」和本 spec 的 Primary Journey（随 #5357 合入）。

## Review Gate

- 由Maine Coon自己定（KD-5）。设计对照由Ragdoll看真实页面，对照北极星 v4 与 DESIGN.md「制作工作台」。
