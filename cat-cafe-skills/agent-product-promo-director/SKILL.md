---
name: agent-product-promo-director
tips_exempt: "Renewed 2026-10-13: human agency, peer collaboration and transitions between worlds refine the existing promo directing method and cold-read questions; dramatization and review order remain unchanged. No new filming tool or user entry."
description: >
  Agent/AI 产品宣传片的创意导演层：先锁产品主角、观众信念变化与影片格式，再把不可见的 Agent
  协作翻译成可拍的故事、镜头、运动、声音和 provenance contract。Use when: 用户问 Agent 产品宣传片
  如何导演/剪辑/叙事/配声音、要拆参考片、写 creative brief/beat sheet，或 video-forge 开机前仍未锁定
  主语与镜头语法。Not for: brief 已冻结后的录制/TTS/对齐/渲染（用 video-forge）、教程/功能 walkthrough、
  目的就是讲角色自己故事的动画（用 anime-forge）、只找时效性竞品（先用 deep-research）。Output: product-hero sentence +
  audience belief change + format decision + claim/proof beat sheet + shot/motion/sound maps + provenance ledger +
  operator acceptance questions。GOTCHA: 用户举的页面、thread 或成果只是候选证据，不自动成为影片主题；内部静态分镜不能冒充成片；
  宣传片的故事层默认可以虚构（§7 `dramatization`），不要写成纪录片。
---

# Agent Product Promo Director

这是一层**创意导演合同**，不是 renderer。它解决 Agent 产品特有的问题：产品的价值常藏在接球、规划、交接、工具动作、纠错、记忆与恢复里；如果只拍最终成果，观众看到的是“它做了什么”，看不到“为什么需要这个产品”。

## Intent Gate

先判断本轮问题：

| Intent | 本轮交付 | 下一步 |
|---|---|---|
| `reference research` | 查官方原片，记录可观察镜头/叙事/声音语法及推断边界 | 时效性强先用 `deep-research`，再回本 Skill 合成 brief |
| `creative direction` | 产品主角、格式、故事、镜头、声音、证据合同 | 由 operator 验收主语与情绪 |
| `production` 且 brief 未锁 | 先完成本 Skill，不开机 | brief 通过后转 `video-forge` |
| `production` 且 brief 已锁 | 不重复导演流程 | 直接转 `video-forge` |
| `review` | 按本合同判断已有片子在卖产品、成果还是功能表 | 给 verdict，不擅自拍新版 |

用户给出的页面、thread、录屏或成果是**候选素材**，不是拍摄授权，也不是自动主题。

## 1. 锁定真正的主角

陌生观众仍无法理解主张时，按[叙事清晰度](../.cat-cafe-shared-refs/narrative-clarity.md)把主张落到人物、任务和因果动作；产品引导中的真实接手与返回另看[交互叙事](../.cat-cafe-shared-refs/interaction-narrative.md)。已锁 brief 的生产不重新走导演判断。

先写三句话：

1. **Before belief:** 观众看片前相信什么？
2. **After belief:** 看完后要改信什么？
3. **Product-hero sentence:** `这个产品让 [谁] 能 [发生什么变化]，同时 [人仍如何拥有关系/控制权]。`

然后做替换测试：把最终成果换成另一种成果，故事仍成立吗？

- 成立：产品是主角，成果是 proof。
- 不成立：影片大概率在卖成果。
- 例外：产品的类别承诺本来就是成果品质（如图像生成）。这时成果可以占更多画面，但选择、迭代、控制和产品身份仍须清楚。

## 2. 选择叙事容器，不迷信时长

| 格式 | 适用问题 | 容器 |
|---|---|---|
| 45–90 秒 brand hero | 一个类别承诺与情绪转变 | 一个愿望 + 2–3 个因果 proof beat + payoff |
| 2–5 分钟 demo film | 复杂能力需要可信过程 | 一个真实案例从意图走到验证结果 |
| 5–10 分钟 launch film | 多个产品支柱与发布语境 | 主持人/情绪脊柱 + 同一项目的章节化展开 |
| tutorial / walkthrough | 教会具体操作 | 任务步骤与理解检查；不要冒充品牌片 |

时长取决于需要改变多少信念、提供多少证据，而不是固定 house number。

## 3. 把 Agent 变成可见动作

每个 proof beat 至少覆盖一条可观察循环：

`意图 → 接受/委托 → 可见工作状态 → 交接/工具/动作 → 人类纠正或控制 → 持久结果 → 延续`

可拍的不是隐秘推理，而是：

- 计划、角色和当前 holder；
- 进度、工具回执、共享空间变化；
- 权限请求、暂停、接管、纠正和恢复；
- 记忆如何让下一步接上，而不是重新开始。

禁止展示或伪造 chain-of-thought。demo film 里证明「产品真能这样做」的那一拍，不要用假进度条、假输入、假并发替代真实行为；宣传片里的戏剧化场景不受这条限制（见 §7 `dramatization`）。

## 4. 写成因果故事

七拍不是固定模板，但每一章必须回答上一章制造的问题：

1. **Tension** — 今天哪里孤单、碎裂、慢或不可控？
2. **Promise** — 产品带来什么新关系或新类别？
3. **First proof** — 用一个小循环教会观众看片语法。
4. **Escalation** — 任务变复杂、跨猫、跨工具或跨端。
5. **Control** — 人能看见、纠正、批准、打断或接管。
6. **Payoff** — 成果工作，并能追溯到前面的动作。
7. **Return** — 回到产品、关系和下一次可能性；不要停在成果 beauty shot。

如果影片有多个功能，每个功能必须成为同一因果任务里的动作，不能各拍一条广告再拼起来。

## 5. 镜头与运动语法

每一拍写清：`观众此刻的问题 / 唯一焦点 / 状态变化 / 为什么此刻移动或切镜`。

- **产品世界是视觉脊柱。** Thread、角色、工具、workspace、权限、纠错与延续保持空间连续性。
- **一拍一件事。** 同时高亮三个面板等于没有焦点。
- **Establish → focus → settle。** 先定位，再揭示变化，最后给观众读懂的时间。
- **主体先动，镜头后动。** 优先 UI 状态、对象、布局、人物和真实动作；镜头只为注意力、亲密、尺度或发现服务。
- **在意义变化处切。** 接球、holder 变化、工具返回、纠正落地、proof 出现都是天然切点。
- **用连续性跨表面。** 位置/形状/动作 match cut，或 J/L sound bridge，把 thread、workspace、浏览器和手机连成同一世界。
- **完成时稳定。** Payoff 需要笃定，不需要再推一次镜头。

运镜不是禁词。现场人物的 dolly、handheld 或空间 reveal 若表达亲密、紧张、探索或尺度，就是有意义的运动。禁的是“世界没动，摄像机焦虑”。

## 6. 声音是因果层，不是糖霜

按以下优先级分配声音空间：

1. **对白/旁白** — 意义与关系。
2. **音乐** — 情绪、章节压力与释放。
3. **SFX/foley** — 因果确认和标点。
4. **静默/负空间** — 层级、纠正与 payoff。

只给重要状态变化做 cue：愿望被接住、球权变化、工作分叉、纠正落地、持久 proof 到达。不要给每个点击配音效。

建立 cue sheet：

| Picture event | Semantic job | Cue type | Priority / ducking | Entry / exit | Proven or vision |
|---|---|---|---|---|---|

- 纠正时可以短暂 duck 或留白，让观众感到“系统听见了”。
- 完成时可以让 motif 解决，而不是再加一层 whoosh。
- 音乐不能铺满所有频率和每一秒；声音设计需要呼吸空间。
- 用日常扬声器和耳机检查对白清晰度，不只看波形和峰值。

## 7. 真相与 provenance

| Source class | 可声称什么 | 处理方式 |
|---|---|---|
| `real_capture` | 事件如画面所示发生过 | 保留来源身份；允许诚实压缩等待时间 |
| `faithful_replay` | 真实状态/动作被重演以便看清 | 内部登记；不冒充未剪纪录片 |
| `designed_explanation` | 用排版、图形或合成 UI 解释真实机制 | 视觉上标示设计感；不伪造隐藏推理 |
| `future_vision` | 尚未实现的愿景 | 动画/未来时态/独立视觉 register |
| `dramatization` | 故事本身：编出来的人物、场景、对白、梦想和结局，用来引起共鸣、讲清主张 | 宣传片故事层的默认素材；不要出处，不标「新写」「重演」。能力成立、只是这个项目因钱或优先级没做完，可以拍成做完，不算 `future_vision`；能力成不成立由 operator 判断 |

**先分片种，再定事实规矩。**
- **宣传片**（brand hero、launch film）：故事层默认用 `dramatization`。要的是陌生人的共鸣，不是事实账本。别把纪录片纪律压到故事上：只敢用真事、给每句台词找出处、照实拍「还没做完」，都是错位。
- **纪录、复盘、产品史和 demo film**：按 `real_capture` / `faithful_replay` 守事实。`video-forge` 的事实规矩是给这类片子的。
- **宣传片里要守的是「当真实证明用的主张」**：片子拿来证明产品能力、业绩或作品归属的，要和事实一致。不能把别人的真作品说成家里做的，不能把编的增长数字当真实成绩；产品做不到的能力按 `future_vision` 拍。编出来的人物和场景（比如虚构仓库上的「12 颗星」）不用查。拿不准时先按戏剧化写，交稿时用一句话标出来，交 operator 定。

## 8. Director Brief 交付合同

复制 [`assets/director-brief-template.md`](assets/director-brief-template.md)，至少填完：

- product-hero sentence 与 before/after belief；
- 格式和选择理由；
- 每拍的 claim、proof、shot role、唯一焦点、state change；
- motion reason、sound cue、source class、must show / must not imply；
- operator 要回答的主语/情绪验收问题。

**operator 先验收主语、关系和情绪，再进入昂贵生产。** 同行只能审事实、技术和证据纪律，不能替代创意 ground truth。静态分镜是内部 previsualization，只回答构图问题。按声音稿时间拼起来的静帧粗片可以验故事和节奏，但证明不了运镜或 motion 成立，也不能作为成片交付。

brief 通过后交给 `video-forge`，由它负责素材、全局旁白、强制对齐、video-spec、渲染和技术审查。贵素材之前，按 `../.cat-cafe-shared-refs/video-voice-and-timeline.md` §1 从便宜到贵给 operator 看：一句话、最危险那一段的最小样张、全片粗片（operator 报时间码改）。样张过之前只做那一段；声音稿只给猫自己查念错、量时长，不单独交 operator 听。

## Failure-history brakes

| 症状 | 真正失败 | 纠正 |
|---|---|---|
| 用户要研究，团队直接开机 | Intent 被偷换 | 回到 reference breakdown + brief |
| 具体成果吃掉全片高潮 | 主语错位 | 做替换测试；回到 product world 收尾 |
| 一个点无限慢慢放大 | 用 camera motion 代偿静态素材 | 补状态/主体动作；只在注意力变化时运镜 |
| 六张静帧加转场 | 用包装冒充 motion | 静帧只验构图；补录/合成真实时间变化 |
| 功能逐条报菜名 | 没有因果任务 | 让功能在同一愿望里依次成为必要动作 |
| 每个 click 都 ding/whoosh | 声音没有语义层级 | 只 cue 因果转折；给对白和静默留空间 |
| 找同行说“通过”但 operator 不买账 | 验收者错位 | 创意直接回 operator，技术事实再找对应 gate |
| 宣传片写成纪录片：只用真事、给台词标出处、照实写「还在练」 | 纪录片的事实纪律压到了宣传片的故事上（operator 2026-10-04 至 10-09 纠正 4 次：「我们又不是拍纪录片」「这是宣传片，不是历史纪录片」「这他妈是个宣传片啊」） | 故事层按 `dramatization` 编到能引起共鸣；只守当真实证明用的主张（§7） |
| 人只出现在聊天框里：界面算人的世界，小楼算猫的世界 | 人的主动性没被演出来：同传、会议这类段落看不到「他想要什么、做了什么」，画面直接跳到结果（《AI-native builder 的一天》，operator 2026-10-12：「我只出现在聊天框里，至少到 2 分半之前」「这里的突兀本质上是缺少了我」） | 关键段落里要看得见：人的愿望或处境、人和猫各自做了什么、结果怎样改变人的下一步。人不必每镜出场，夜里猫自己干活、猫的特写、界面近景都可以成立，但离开人物的镜头要能接回这条关系。界面可以放进他手里的设备；人可以只出背影，方便观众代入 |
| 把家里的猫编成「X 队」，一队一只猫 | You 觉得「队」听起来像 agent team 的主从结构；家里是住在同一个 thread 里的对等协作，「一队只有一只猫」看着也怪（同片，operator 2026-10-12） | 不编队，直接说那件事本身（「鸭鸭学踢球」）。对等不靠猫的数量或硬塞 review 台词证明：在有代表性的协作段落里，让观众看见不同的猫各自提出判断、接话或修订，一起改变同一件事 |
| 冷读说看不懂，就加章节卡和注释 | 卡片越加越多，后半段像功能清单（同片第二次模拟冷读：「越来越像功能清单」） | 先把缺掉的那一步动作演出来，再考虑加字。必要的术语可以在第一次需要时用一句短注；标题若保留，用来帮观众追踪故事里的问题，不写成功能名（见 `../.cat-cafe-shared-refs/narrative-clarity.md` §3） |
| 表里两个世界各拍各的，在两边来回硬切 | 观众每切一次都要重新找自己在哪，两个世界的关系没被演出来（《AI-native builder 的一天》早饭段第一版，10-12）。operator：「完全可以一个镜头我的背影然后拉进到屏幕进入屏幕里 看真实表世界，然后切里世界……人家大导演都是如何表现表里的」 | 给每个世界定一扇固定的门，每次进出都走它（笔记本屏幕、毛线球）。过门要有理由：这边一个动作引起那边一个动作。用形状或方向对上来过门（剪辑台上标红的那格 → 小楼显示器上的同一格；毛线球从右边滚出 → 从左边滚进来）。同一件东西在两边各有一个样子（演员表 ↔ 聊天里的一条消息）。人的身体可以当开关（往前凑就推进屏幕，往后靠就退出来）。可参照：《黑客帝国》的屏幕和电话线、《盗梦空间》的跨层因果、《头脑特工队》的总部与外面、今敏的匹配剪辑 |

## Pressure tests

交付 brief 前逐题回答：

0. 关键段落里，观众看得见人的愿望或处境、人和猫各自的行动，以及结果怎样改变人的下一步吗？离开人物的镜头能接回这条关系吗？

1. 把案例页面/最终成果换掉，产品故事还成立吗？
2. 观众能指出意图、holder、动作、纠正、结果和延续分别在哪里吗？
3. 每个主要镜头里，世界内部发生了什么？若只剩 zoom，删掉会怎样？
4. 每个剪切是因为意义变化，还是因为时间到了？有没有一个东西（形状、方向、动作、声音）把观众带过去？
5. 每个声音 cue 的语义工作是什么？删掉是否损失因果或情绪？
6. 这是宣传片还是纪录/demo？宣传片的故事层有没有被纪录片纪律捆住？当真实证明用的能力、业绩和作品归属，和事实一致吗？
7. 若成果本来就是产品承诺，产品的控制与迭代仍清楚吗？
8. 这是 brand hero、demo film、launch film 还是 tutorial？当前时长真的匹配吗？
9. operator 验收的是主语/情绪，还是被迫审内部制作脚手架？

## Related

- 时效性竞品与官方原片查证：`deep-research` + `source-audit`
- 已冻结 brief 的视频生产：`video-forge`
- 主角是家里的猫、片里有剧情的产品宣传片，仍由本 skill 定方向、`video-forge` 生产；要画的角色段落，画稿照 `anime-forge` 的 `assets/art-brief-header.md`
- 目的就是讲角色自己故事的短片：`anime-forge`
- 本方法的证据与条件分支：*(internal reference removed)*
