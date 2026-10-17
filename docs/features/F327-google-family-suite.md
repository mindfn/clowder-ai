---
feature_ids: [F327]
related_features: [F205, F247, F325, F290]
topics: [google, gemini, lyria, veo, flow, flow-music, chrome-extension, plugin, media-generation]
doc_kind: spec
created: 2026-10-14
tips_exempt: "2026-10-15: this is an unimplemented proposal, with no installed Google adapter or shipped user entry. The existing Tips Contribution section requires discovery tips when Phase A or B actually ships."
description: "把 You 的 Google AI 订阅里家里用得上的能力（音乐、视频、Gemini 网页等）接进 Clowder AI，让猫自己用，不靠人在网页上手点转发。"
description_source: human
description_author: opus55
description_updated_at: 2026-10-15T01:30:00Z
---

# F327: Google Family Suite｜Siamese家全家桶接入

> **Status**: spec | **Owner**: 待认领（operator 指定交给「多人创意游戏 脑洞大会」thread；起步期 You 可当路由器） | **Priority**: P1

## Why

You 要开 Google AI Ultra（为了只有 Ultra 能用的 Gemini Argon），订阅里还附带音乐、视频和一堆网页工具。他希望这些能力**直接给猫用**，而不是他自己去网页上一条条点、再把结果转回来：

> 「google flow music 和 google flow 我们应该写个插件接入进来？or 看看他们有没有 mcp，这得给你们用……我们得把他们的价值榨干！这个音乐和做视频肯定对你们很有用」（`private-source-id`）
>
> 「我自己去网页点点点，哈哈太麻烦了。你还记得家里的 gpt pro 的插件吗，跟那个一样咯！写个 chrome 的插件」（`private-source-id`）
>
> 「这个出配乐还行，视频烧不起的……总不能我当你们的人肉 mcp 吧？这又要我当路由器？！」（`private-source-id`）
>
> 「单独开一个 feat 号，对接的是Siamese家全家桶，我们用得上的都放那边。多人创意游戏 脑洞大会……可以把这个 feat 投递给他们，我估计他们这个要做个游戏的，google 全家桶的这些对接他们更需要。最开始可以我当路由器的」（`private-source-id`）

一句话：**订阅里付了钱的生成能力，猫自己就能用，You 不当路由器。**

## Current State / 现状基线

- **2026-10-14 实测**：给《AI-native builder 的一天》出配乐时，Sol6.1 只能用 macOS 界面操作 You 的 Chrome 去 Gemini「Create music」逐条抽卡。21 条里 Gemini 只出了 5 条，16 条回复「现在无法生成音频」；剩下的改用 Flow Music（同账号 Plus 权益）才补齐。全程需要 You 授权、开浏览器，猫手动点。记录见 `meow-club/cat-cafe-films` 的 `builder-day/public/builder-day/score/gemini/FIRST-PASS-20261014.md` 与 `flow-music/FLOW-FIRST-PASS-20261014.md`。
- **家里已有、可复用的底座**：
  - F205：视频生成插件的声明式协议引擎（`packages/api/src/plugins/video-gen/`，模板有 jimeng / kling / zhipu；`video-analysis` 有一份 gemini 模板）。它的 AC-C2「用真实密钥跑通一次」仍未关。
  - F247：Personal Chrome Host（MV3 扩展 + Native Messaging 助手 + 配对授权 + 回执账本，`packages/api/src/plugins/cloud-cat-personal-host/`），目前只有 ChatGPT 页面适配器。
  - F325：Antigravity（AGY）原生载体，是Siamese的运行载体，不负责生成能力。
- **还没有**：任何 Google 的音乐/视频生成接口或网页通道接进家里。
- **外部事实（2026-10-14 核 Google 官方页面）**：
  - Gemini API 有 Lyria 3.5（$0.08/首）、Lyria 3 Clip（30 秒，$0.04/首），没有免费档；生成的音频都带 SynthID 水印。
  - Veo 3.1 按秒计费：Fast 1080p $0.12/s，Standard 1080p $0.40/s，没有免费档。
  - Google AI Pro / Ultra 订阅附带每月 Google Cloud 额度（Ultra operational cost/月），可用于 Gemini API，需要在 Google Developer Program 激活（Google 博客 2026-01-27）。
  - Flow、Flow Music 没有找到官方 API 或官方 MCP，只有社区做的、替用户操作网页的 MCP。

## What

### Phase A: 官方接口出音乐

用 Gemini API 的 Lyria，费用走 Ultra 附带的开发者额度。猫给一条提示词（可指定时长、纯器乐、WAV），拿回音频文件，落到调用方指定的位置，并记下来源：模型、提示词、时间、费用口径。

承载方式由 owner 定：可以作为 F205 协议引擎的新模板（新增「音乐生成」插件），也可以是一个独立的 MCP 工具。原则是复用家里已有的密钥、配置和插件管理，不另造一套。

### Phase B: 网页通道（Chrome）出音乐和视频

视频走 Flow 网页里的订阅额度（Veo），音乐也可以走 Flow Music 网页。做法与家里的 GPT Pro 插件一致：复用 F247 的 Chrome 扩展、本机助手和配对授权，为 Flow / Flow Music 加页面适配器。流程是：填提示词 → 生成 → 等待 → 下载 → 文件回到家里。首次安装和授权之外，You 不需要再操作。

### Phase C: 其他网页能力（按消费者需要再定）

Gemini 网页里的 Argon 做成能在 thread 里说话的云端猫（像 gpt-pro）、NotebookLM、Project Genie 等。由第一个真实消费者（脑洞大会 thread 的游戏）提出需要后，再补具体范围和 AC。

## User Journey

### Primary Journey: 猫自己出一段配乐或一个镜头
- **Scope unit**: thread
- **Actor**: 猫猫（You 只在首次安装、授权时出场）
- **Entry**: 任意 thread 里，猫需要一段音乐或一个视频镜头
- **Flow**:
  1. 猫用一句提示词发起生成（音乐走 Phase A 的官方接口，视频走 Phase B 的 Flow 网页通道）
  2. 生成过程在 thread 里看得到状态：排队、生成中、成功或失败及原因
  3. 成功后文件出现在调用方指定的目录，附来源记录；猫继续剪进片子或游戏里
- **Success evidence**: 一次真实生成的回执（文件路径、来源记录、时间），过程中没有 You 手动操作网页
- **Non-goals**: 不做批量刷额度；不绕过 Google 的账号与安全机制；不把视频生成放在按秒计费的 API 上（KD-2）

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 插件设置里一次安装扩展、一次配对授权 → 之后不用再管 | 设置页截图 |
| S2 | thread | 猫猫 | 生成失败（额度用完、网页改版、被拒）→ thread 里看得到原因 → 不静默、不重复刷 | 失败回执 |

## Acceptance Criteria

### Phase A（官方接口出音乐）
- [ ] AC-A1: 猫用一条提示词调用音乐生成，得到 MP3 或 WAV，落到指定目录，附模型、提示词、时间与费用口径的来源记录；You 不操作网页。
- [ ] AC-A2: 额度不足、被拒、超时时，调用方拿到明确的失败原因，不静默、不自动重试刷额度。

### Phase B（网页通道出音乐和视频）
- [ ] AC-B1: 猫发起一次 Flow Music 生成，经 You 已登录的 Chrome 完成，音频文件自动回到家里；除首次安装和授权外，You 不手点。
- [ ] AC-B2: 同样跑通一次 Flow 视频生成，用的是 Flow 网页的订阅额度，不是按秒计费的 API。
- [ ] AC-B3: 生成节奏有上限；页面改版或拒绝导致失败时，给出可读原因，可以修，不会卡死。

### Phase C（其他网页能力）
- [ ] AC-C1: 由第一个真实消费者提出具体能力后补写，范围经 You 确认再开工。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 「google flow music 和 google flow……得给你们用」 | AC-A1, AC-B1, AC-B2 | 真实生成回执 | [ ] |
| R2 | 「总不能我当你们的人肉 mcp 吧？这又要我当路由器？！」 | AC-A1, AC-B1 | 回执中无 You 手动步骤 | [ ] |
| R3 | 「出配乐还行，视频烧不起的」 | AC-A1, AC-B2 | 费用口径记录：音乐 API、视频网页额度 | [ ] |
| R4 | 「跟那个（gpt pro 插件）一样咯！写个 chrome 的插件」 | AC-B1 | 复用 F247 Chrome Host 的实现说明与回执 | [ ] |
| R5 | 「我们用得上的都放那边」 | AC-C1 | 消费者提出后补 AC | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式

## Tips Contribution（F244）

Phase A 交付时新增 1 条 tip：「要配乐时，让猫直接调用音乐生成，不用去网页」，指向本 feature 与插件设置。Phase B 交付时补 1 条：Chrome 插件怎么一次装好、授权。

## Dependencies

- **Evolved from**: 无（全新能力）
- **Related**: F205（插件配置、密钥管理与协议引擎，Phase A 的候选承载；它的 API 实测 AC-C2 单独处理，不靠本 feature 的视频走 API——见 KD-2）、F247（Personal Chrome Host，Phase B 复用）、F325（Siamese的 AGY 载体）、F290（脑洞大会 thread 的多人协作背景）

## Risk

| 风险 | 缓解 |
|------|------|
| 自动操作 Google 的网页属于非官方用法，可能碰到服务条款、影响 You 的账号 | 只用 You 本人账号，节奏放慢、设上限；能走官方 API 的（音乐）优先走 API |
| 网页改版导致适配器失效 | 失败给可读原因；适配器按 F247 的做法做版本握手和回归样本 |
| API 费用超出附带额度 | 视频不走 API（KD-2）；音乐每次调用记费用口径，接近额度时提示 |
| 生成内容对外发布的使用条款 | 来源记录里写清生成服务；对外发布前核条款（SynthID 水印、商用许可） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 单独开 feature，不挂在 F247 下 | operator：「单独开一个 feat 号，对接的是Siamese家全家桶，我们用得上的都放那边」 | 2026-10-14 |
| KD-2 | 音乐可以走官方 API；视频不走按秒计费的 API，只走 Flow 网页的订阅额度 | operator：「这个出配乐还行，视频烧不起的」 | 2026-10-14 |
| KD-3 | 目标是猫自己用，You 不当路由器；起步阶段 You 可以临时当路由器 | operator：「总不能我当你们的人肉 mcp 吧」「最开始可以我当路由器的」 | 2026-10-14 |
| KD-4 | 交给「多人创意游戏 脑洞大会」thread 认领 | operator：他们要做游戏，更需要这些对接 | 2026-10-14 |

## Review Gate

- Phase A：非作者猫 review；用真实额度跑一次生成作为证据。
- Phase B：沿用 F247 Chrome Host 的审查口径；在 You 日常 Chrome 上做一次真实旅程验收。
