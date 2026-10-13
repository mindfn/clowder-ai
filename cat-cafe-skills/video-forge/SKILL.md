---
name: video-forge
tips_exempt: "Renewed 2026-10-13: music auditions, continuous-cut review and cat-run film statistics improve the existing production method. The command is a creator diagnostic, not a new user-facing product entry; dramatization and sample-first review remain unchanged."
description: >
  用 Remotion 做有品味的视频：从一句话 brief 或一堆素材出发，先在素材里找戏（主张、反转、因果），
  再推出风格、按声音排时间、写 Remotion 合成、用样张自审，交给 operator 看片。
  Use when: 要做或改一支视频（宣传短片、产品界面演示、讲解/纪录片段、动态排版、录屏剪辑），
  包括主角是家里的猫、片里有剧情的产品宣传片；或写、审 Remotion 代码的画面、运动、节奏与声音。
  Not for: 只查某个 Remotion API 怎么写（读官方 remotion-best-practices skill 的 rules/）；
  目的就是讲角色自己故事的动画短片（用 anime-forge）；Agent 产品宣传片还没想清楚讲什么（先用 agent-product-promo-director）；PPT（用 ppt-forge）。
  Output: 一页 treatment + Remotion 工程 + 样张 contact sheet + Console 内联可播的预览片/成片。
---

# Video Forge：用 Remotion 做一支好看的片子

> 2026-10-04 重写。You 的标准："一句话做出来就让人想看完"。
>
> **先读 `refs/method.md`**：从素材里找戏、推出风格、让时间干活、边做边看、交出去听原话，一共五步。它是这份 skill 的核心，换任何题目都用得上。`taste.md` 是手艺标准，`remotion-build.md` 是工程，案例和工具只是方便。**工具可以不用，五步不能跳。**

## 为什么这是一份 skill

模型会写 Remotion 代码，但压力下会做出 PPT：静态画面加推拉、字淡入淡出、每个镜头都慢慢缩放、整页网页缩进画面、慢吞吞的插值占满时长。还有一种更隐蔽的失败：画面很干净，却没有故事。家里这些全踩过（见文末）。这份 skill 管四件模型不会自己做的事：**从素材里找出戏来**、**替人定审美**、**按节拍而不是按感觉排时间**、**渲染后真的去看样张**。API 用法交给官方 skill，这里不重复。

## 流程

```
一句话 brief / 一堆素材
  → 方法五步的前三步想清楚（refs/method.md）
  → treatment.md（一页纸：故事、风格语法表、情绪曲线、假设）→ 主张和反转压成一句话，先给 You（已接受的 brief 直接用）
  → 最小样张：只做最可能毁掉整片的那一段（这段的配音与回听、局部时间线、搭建、自审）→ 给 You 看
  → 过了再铺全片：声音稿（逐句合成 + Whisper 回听，猫自己用来查念错、量时长）→ 时间线（配音逐词对齐 / 音乐拍点）
    → Remotion 搭建（theme.ts + 场景 + 镜头）→ 样张自审（contact sheet 五问）
  → 全片粗片 → 给 You 看 → 按他一句话改
  → 成片
```

1. **treatment**：按 `refs/method.md` 第一到三步逐条回答：素材清单、主张、藏起来的证据（反转）、因果排列、观众记住的一句；风格从哪来、语法表、换素材测试；拍速、情绪曲线、最大的转折放在哪段安静里。再补色板、字体、片长（`refs/taste.md` §0）。**不要回头问一串开局参数**；拿不准的写成假设，片子出来他一眼就能改。只有一件事要先问，因为它会改方向：给谁看（家里看还是公开发）。这决定克隆声线、配乐和素材能不能用。写完把主张和反转压成一句话先给 You；已经接受过的 brief 直接用，不再要他点头。
2. **声音稿与时间线**：最小样张只录那一段；样张过了再录全篇。有台词或旁白，录声音稿：`scripts/tts-check.py` 逐句合成、Whisper 回听，参考音先用 `--check-ref` 核对文字。声音稿是自己用的，不单独交 You 听：TTS 念白是片子最平的样子，他判断不了好坏。正式配音若是单一旁白的连续解说，可以整篇重新合成来保住语气，这时要整段回听、重新对齐。时间轴只按最终用进片子的那版音频排：时长从这版音频量，再强制对齐出逐词时间，用 `assets/craft/beats.ts` 变成节拍；只有音乐就按 BPM 或 `scripts/music-cues.py` 测出的起音点排。渲染前跑 `scripts/timeline-check.py`，两句话不许叠。见 `refs/remotion-build.md` §3 和共享参考 `../.cat-cafe-shared-refs/video-voice-and-timeline.md`。
3. **搭建**：先读官方 skill 里对应的 `rules/*.md`，再写。把 `assets/craft/` 复制进工程（运动曲线与时长、镜头、遮罩出字、节拍）。全片取值只来自 `theme.ts`。
4. **样张自审**：`scripts/contact-sheet.sh` 把每个节拍的开头、中间、结尾拼成一张图，用 Read 逐格看，过 `refs/taste.md` §10 的五问。不过就改，不拿去给人看。
5. **给人看**：从便宜到贵（共享参考 §1）。有制作成本的第一样，是最可能毁掉整片的那一段做成 10–20 秒的最小样张；过了再给全片粗片（草图或静帧按真实台词时长拼起来）。静帧粗片可以用来验故事和节奏，不能当成片交付。草稿片按 `rich-messaging` 的视频规则发成 Console 内联播放器，附样张和 treatment。品味由 You 定；别的猫只审事实、技术、音画同步。

## 硬规矩（扫一眼版）

| 规矩 | 一句话 |
|---|---|
| 画面内部必须有事发生 | 只有镜头在推拉、只有字在淡入，不算动作 |
| 镜头默认锁定 | 运镜要有理由，0.6–1.2 秒，以停住结束；不给每个镜头加慢缩放 |
| 能切就不移 | 从全景切到特写，比推过去干脆 |
| 按最终画面排版 | 不把整页缩进画面；正文 ≥ 32px（1080p） |
| 一帧一个焦点 | 其余退后：变暗、变淡、变模糊 |
| 字用遮罩出现 | `assets/craft/Reveal.tsx`；一句只强调一个词 |
| 没有线性运动 | 曲线按用途取 `assets/craft/motion.ts` |
| 时间跟着声音走 | 节拍从对齐结果或 BPM 算；场景里不写死帧数；时间码只从时间轴 JSON 取 |
| 每句台词都回听 | Whisper 听写对不上就换说法重录；听写只当提醒，不当证据 |
| 音效要么像，要么不放 | 只放一听就懂的几声；合成的小音不像就删 |
| 观众不该干等 | 按片子类型安排变化与有意的停顿，不按秒表；只有位置在变、没有意义的镜头剪短 |
| 转场要有载体 | 说不出哪个东西把观众带进下一镜，就硬切 |
| 确定性 | 只用 `useCurrentFrame()`；`random(seed)`；字体图片等加载 |

## 片子在讲事实时

纪录、复盘、产品史这类片子，事实规矩跟着项目走：原话不改字，重演要标"重演"，概念稿要标"未实现"，没拿到的原文不编。好看不能拿事实换。宣传片的故事层不套这条：人物、场景、台词可以编，只有当真实证明用的能力、业绩、作品归属要和事实一致（见 `agent-product-promo-director` §7）。

## 家里踩过的坑（2026-08 至 10 月）

| 做法 | 当时的结论 | 改法 |
|---|---|---|
| 每个镜头持续慢慢推近，然后切 | You："看的我好晕"（08-25） | 镜头锁定，运镜以停住结束 |
| 六张精修静帧 + 推拉转场 | You："把我们的视频变成了 ppt"（08-25） | 画面内部要有状态变化 |
| 整页 HTML 原样缩进 1920×1080 | You："字太小了我根本看不见，画面太空了"（08-27） | 只取发生事情的那块，放大 |
| 程序化树枝慢插值占满 178 秒 | You："信息密度太低了吧"（09-04） | 按内容安排节拍，剪掉没有意义的等待，能短就短 |
| 固定机位 + 左栏字 + 循环光点（EP04 第四稿，10 月初） | 导演复盘（10-03）：读起来像幻灯片 | 字进画面里，镜头跟事件走 |
| 用户让"研究怎么剪"，猫直接开拍试片（08-25） | 连拍几版，原问题没回答 | 研究问题交 `agent-product-promo-director`，开拍要等方向定 |
| 一句话 brief 只做了三镜干净排版（本 skill 第一支样片，10-04） | You："有点太简单了，我看不出什么品味" | 一句话也要有角色、冲突、反转，风格选一个有性格的做到底 |
| 参考音配错了文字（《醋醋喵》EP0，10-04） | 旁白开口先念出参考文字，后面全是胡言乱语，16 句全坏 | 用参考音前跑 `tts-check.py --check-ref` |
| 每个动作都配一个合成音效（EP0） | You："音效还是很奇怪" | 只留一听就懂的几声，正式音效后期做 |
| 跨镜头的长句压到下一句（EP0） | 两层字幕叠在一起 | 渲染前跑 `timeline-check.py` |
| 反复复用 `make-score.py` 的同一套预设，没试听就当正式 BGM（变脸记、醋醋喵、《AI-native builder 的一天》） | You：「这个 BGM 是你什么御用 BGM？……它真的好奇怪」（10-12，EP0 之后第二次嫌声音怪） | 这套预设默认只用来排节奏、占位。正式音乐按段落情绪、对白和静默的效果试听后选用；来源和费用沿 You 已给的授权走（10-12 已允许 AI 生成和免费曲库），不为来源重复请示。来源不是质量判据，听起来对才算 |
| 模拟冷读只给截帧和台词（《AI-native builder 的一天》，10-12） | 截帧能看出谁在画面里（第一次冷读已经说过人何时出现、两个世界关系不清），但看不到连续动作、时长感受和声音；「BGM 怪」是 You 自己看片才发现的 | 交冷读结果时写明它验证不了什么。声明节奏或声音完成之前，用带声的连续成片自己验一遍。模型模拟的冷读不等于真实陌生观众已经看懂（`../.cat-cafe-shared-refs/narrative-clarity.md` §5） |
| 一句台词一个镜头，在背影、屏幕近景、工作室远景和近景四处来回跳；10 次切换里只有毛线球那 1 次有东西带着过去；两句台词之间是死寂（《AI-native builder 的一天》早饭段第一版，10-12） | You 先问「为什么看起来还是像ppt？」，又问「为什么云端的你做的 不像ppt ？ 他也是合成」。我先归因成画面不动，可他认可的云端那支同样有 75% 的帧不动，却没有一次硬切、几乎没有无声（我们是 84%、10 次、41%）。照「一个舞台、两扇门」重做后（静止 45%，真正的切换 4 处都有东西带着过去，无声 1.6%），You：「现在味道倒是对了」 | 嫌像 PPT 时，先用 `scripts/film-stats.py` 给自己的片子和他认可的参考片量同一组数，再找原因。少换场景，把戏放进一个舞台，镜头在里面走；每次切换都要说得出是什么带观众过去（形状对上、方向对上、这边一个动作引起那边一个动作、下一边的声音先进来）；声音底子不断 |

## 家里的工具

| 东西 | 在哪 |
|---|---|
| Remotion 工作台（4.0.438，已装官方 skill） | You 机器 `~/projects/remotion-studio`；别人有未提交改动，只在自己的 `src/<Film>/` 里干活 |
| 新建视频目录 | `pnpm video:new <slug>`（生成 `docs/videos/<slug>/`） |
| 逐词强制对齐 | `scripts/video-forge/align.py`（Qwen3-ForcedAligner） |
| 官方 Remotion skill | 工程里 `npx remotion skills add` / `update` |
| 自己合成配乐和音效（无版权，卡在画面网格上；预设默认当占位，正式配乐见上面的坑） | `scripts/make-score.py <out> --bars N --sections "0-1:intro,2-9:groove,..." [--mute 起-止帧]` |
| 量「像不像幻灯片」：静止帧占比、切点候选、无声占比，和参考片一起量 | `scripts/film-stats.py <片子> [参考片...]`（要 ffmpeg 和 numpy；切点候选里混着快速运镜，要逐个打开看是不是真切、有没有载体） |
| 音乐拍点（没有稳定 BPM 时） | `scripts/music-cues.py <音频> --end-ms <片长>`（要 ffmpeg 和 numpy） |
| 样张 | `scripts/contact-sheet.sh <video> <out.png> <帧号...>` |
| 声音稿：逐句合成 + Whisper 回听；核对参考音 | `scripts/tts-check.py lines.json voices.json out/`；`--check-ref 参考音.wav "文字"` |
| 时间轴检查（对白重叠、镜头缝） | `scripts/timeline-check.py timeline.json` |
| 范例 | `refs/case-xianxian-faces.md`：方法五步在一支八格表情图短片上的一次应用（看怎么推，不抄风格）；`assets/example/README.md`：13 秒技术范例 |
| 多段 AI 生成素材拼成"一镜到底" | `refs/continuity.md` 的接缝五问 |

## 和别的 skill 的区别

- `agent-product-promo-director`：Agent 产品宣传片还不知道主角和要讲的信念时，先去那里定方向；定了再回来做。
- `anime-forge`：按片子的目的分：推产品、讲功能的片子（宣传片、讲解片、demo），哪怕主角是家里的猫、片里有剧情，也走 `agent-product-promo-director` 定方向、`video-forge` 生产；目的就是讲角色自己故事的（醋醋喵这类连载、家里真事改编）才走 `anime-forge`。宣传片里要画出来的猫角色段落，流程留在本 skill，画稿照 anime-forge 的 `assets/art-brief-header.md` 写。两边共用 `../.cat-cafe-shared-refs/video-voice-and-timeline.md`。
- 官方 `remotion-best-practices`：API 怎么写。本 skill：拍什么、怎么排、做得好不好看。
- `ppt-forge`：要的是幻灯片，不是视频。

## 下一步

草稿片给 You 看后按他的话改（不必开新流程）；成片要对外发布时，事实类片子请一只非作者的猫核一遍事实，再交 `rich-messaging` 投递。
