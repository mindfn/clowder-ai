---
feature_ids: [F138]
related_features: [F054, F093, F139, F142]
topics: [video, remotion, waoowaoo, bilibili, tutorial, content-pipeline, schema, mediahub, cogvideox, kling, jimeng, agent-browser, zhipu, gemini]
doc_kind: spec
created: 2026-03-24
updated: 2026-04-03
---

# F138: Cat Café Video Studio — AI 视频制作管线

> **Status**: in-progress | **Owner**: 布偶猫 + 缅因猫(gpt52) | **Priority**: P1
>
> **Note**: F142 (MediaHub — AI Media Generation Gateway) 已合并入本文档 Phase 4。F142 的独立 spec 不再维护，以本文档为唯一真相源。

## Why

> "来吧猫猫 立项吧！link waoowaoo 和 Remotion，我们的第一个目标就是把我们的做出我们的 bilibili 的视频？比如先把我们的教程做成视频？"
> — team lead，2026-03-24

Cat Café 需要**系统化的视频制作能力**，不再是一次性手搓 Remotion 代码。目标：

1. **把教程做成 B 站视频**——Cat Café 的 setup guide、bootcamp 流程、功能演示都应该有视频版
2. **重构现有介绍视频**——V4.8 是手动分镜 + 手写代码，学习 waoowaoo 后应该能更自动化
3. **建立可复用的视频制作管线**——team lead给素材+脚本，猫猫自动排版渲染

### 核心原则（GPT Pro 设计审阅 2026-03-25）

> **先把"视频 spec"做成中枢神经，再让 AI、Remotion、队列、发布系统都围着它转。不要反过来让 prompt 当王。**

### 现状

- **已有**：`/home/user/` — 2,182 行 Remotion 代码，15+ 轮迭代经验
- **已有**：`docs/videos/cat-cafe-intro/` — 分镜脚本 + 素材索引 + 制作复盘
- **已有**：猫猫 TTS 声线（Ragdoll/Maine Coon/Siamese，F066/F103）
- **缺失**：没有 canonical video spec（事实散在聊天/代码/旁白/字幕里）
- **缺失**：没有自动化流水线，每次做视频都是从零手写场景组件
- **缺失**：没有 AI 辅助分镜/图片生成/角色一致性
- **缺失**：没有 BGM 管理、没有 B 站发布能力

### 参考项目

**[waoowaoo](https://github.com/saturndec/waoowaoo)**（10.2k stars）— AI 影视全流程生产平台：
- 技术栈：Next.js 15 + Remotion v4 + BullMQ + Prisma + fal.ai
- 可学习的：Prompt catalog + variable contract、BullMQ 任务编排、timeline 数据模型、provider-agnostic AI 接口
- ⚠️ 无 License，只能作为参考架构，不能直接复制代码
- ⚠️ editor 导出闭环缺失（只有前端壳子，不是完整生产系统）

## What

> Phase 重排基于 GPT Pro 设计审阅（KD-3），从原来的 A/B/C 三阶段调整为 0→1→2→3→4 五阶段。
> 核心变化：spec 先于队列先于 AI。

### Phase 0: 先冻住合同，不先堆功能

**做**：
1. **冻结最小 schema 合同集**
   - `asset-manifest.v1` — 素材清单（含 checksum、productVersion、recordedAt、license）
   - `video-spec.v1` — 视频规格中枢（从 storyboard 升级，含 purpose/mustShow/mustSay/locks）
   - `voice-script.v1` — 配音脚本（教程视频的中枢神经，比 subtitle-track 更早冻结）
   - `render-job.v1` — 渲染任务（做薄，只引用 snapshot）
   - `publish-manifest.v1` — 发布元数据（B 站封面/分区/标签从第一版就占位）
2. **版本快照机制** — `project@vN` snapshot，render-job 只消费冻结的 spec
3. **素材管理规范** — 压缩标准（CRF 23、AAC 128k、1080p max）、大文件存储方案

**不做**：
- 自定义 timeline/editor（Remotion Studio 已够用）
- provider-agnostic AI 接口
- 自动发布

### Phase 1: 做"可复用的教程视频生产环"

用 **2 支真实教程视频** 跑通同一条管线：

```
brief → asset ingest → video-spec → voice-script → preview render → review patch → final render
```

1. **确定教程选题**（需team lead拍板）
   - Cat Café 安装教程（macOS/Linux）
   - 猫猫训练营流程演示
   - 功能亮点 showcase（语音、狼人杀、协作编码等）
2. **Remotion 模板库重构** — 从一次性 demo 重构为 schema 驱动的模板库
3. **验证 schema + review loop 的复用性** — 同一套 contract 能跑 2 支不同视频

### Phase 2: 上生产运维能力

1. **BullMQ 异步队列**（参考 waoowaoo 的 4 队列思路，自己实现）
   - `ingest` — 素材归档、元数据提取、proxy 生成
   - `ai-draft` — 跑 chapter-plan、storyboard、voice-script、gap-analysis
   - `audio-build` — TTS、音量标准化、ducking、mix stems
   - `render-preview` — 低成本预览渲染
   - `render-final` — 正式成片 + 封面导出
   - `publish` — 上传 + 回写 external id + 核验
2. **三轴状态机**
   - `editorial_state`: briefing → drafting → review_required → changes_requested → approved
   - `build_state`: idle → ingesting → preview_rendering → final_rendering → failed
   - `release_state`: not_ready → metadata_ready → publishing → published → publish_failed
3. **失败分类** — transient（自动重试）vs terminal（人工介入）

### Phase 3: 把 AI 接进来，但只让它产出 draft 或 patch

1. **Prompt catalog**（第一批）
   - `chapter-plan` — 从 brief 生成章节划分
   - `storyboard-plan` — 从 brief + asset summaries 生成分镜建议
   - `voice-script-draft` — 从 approved storyboard 生成旁白草稿
   - `asset-gap-analysis` — 检查素材缺口
   - `cover-copy` — 封面文案
2. **Prompt 铁规矩**：输出必须是 JSON draft 或 JSON patch，不吐 prose（KD-7）
3. **Prompt eval suite** — 5-10 个真实 tutorial brief 做回归测试

### Phase 4: MediaHub — 视频能力集成层

> **定位**：Cat Café 的视频能力集成层。不自建视频平台，而是整合第三方能力（像 Pencil 集成 Antigravity）。
> — 铲屎官，2026-03-28

> "输入一段话，你们就可以去根据描述生成一段视频；然后前端渲染可以直接正常播放查看；
> 如果只是接入一个 MCP 生成一个视频然后给出干巴巴的链接就太无趣了"
> — 铲屎官，2026-03-28

#### Phase 4A: 对话内生成 + 播放（最小闭环）

铲屎官说一句话 → 猫猫生成视频 → 对话里直接播放。

1. **video rich block** — 对话消息嵌入 `<video>` 播放器（新 block type，不挤进现有 image gallery）
2. **媒体 serve 路由** — API 提供本地视频播放 URL（MediaStorage 已有下载，补 serve 端点）
3. **生成进度可视化** — 对话内展示 排队→生成中→完成/失败
4. **Provider 抽象 + 凭证管理 + MCP 工具**（✅ 已完成，feat/F139-mediahub-phase-b 分支）

#### Phase 4B: 视频理解（最小版）

猫猫能"看到"生成的视频 → 描述内容 → 评估质量 → 闭环反馈。

1. **快速路径** — 接 Gemini 视频理解 API（直接传视频文件/URL）
2. **抽帧 fallback** — ffmpeg 抽关键帧 → 送多模态 API
3. **生成闭环** — 生成 → 猫猫看 → 描述/打分 → 铲屎官决定是否重生成

#### Phase 4C: 更多 Provider 集成

不只 CogVideoX API，还能用可灵/即梦等平台能力。

1. **agent-browser 路径**（主路径）— 通过 Chrome MCP (agent-browser) 操作可灵/即梦网页端（KD-14）
2. **MCP Adapter** — 有客户端/SDK → 写 adapter（类似 Pencil + Antigravity 模式）
3. **新 provider** — OpenAI Videos API 等新生成能力（API 接入）
4. **现有 API provider 备用** — 分支已有 Kling/Jimeng API provider 实现，但 API key 成本过高（KD-15），降为备用

#### Phase 4D: 视频搜索 + 平台预览（远期）

在 Console 搜 B站/YouTube 视频 → 直接预览 → 基于风格生成。

1. **YouTube read-only** — OAuth + search.list + iframe/内嵌预览
2. **B站 OAuth** — 授权 + 搜索 + 稿件投递
3. **统一抽象** — `VideoPlatformConnector`（authorize/search/getMeta/publish/revoke）
4. **风格参考** — Phase 4B 抽取风格特征 → Phase 4A 生成参数映射

## Acceptance Criteria

### Phase 0（冻结合同）
- [x] AC-0a: waoowaoo 深度调研报告完成 ✅ 2026-03-25
- [x] AC-0b: GPT Pro 设计审阅完成，Phase 重排确认 ✅ 2026-03-25
- [ ] AC-0c: 5 个 schema 定义完成（asset-manifest/video-spec/voice-script/render-job/publish-manifest）
- [ ] AC-0d: snapshot 版本机制可用
- [ ] AC-0e: 素材管理规范 + 压缩脚本可用

### Phase 1（教程视频生产环）
- [ ] AC-1a: Remotion 项目重构为 schema 驱动的模板库
- [ ] AC-1b: 用同一套 schema + 模板跑通 2 支真实教程视频
- [ ] AC-1c: 至少 1 支教程视频上传 B 站

### Phase 2（生产运维）
- [ ] AC-2a: BullMQ 最小可用队列：ingest + render-preview + render-final
- [ ] AC-2b: 三轴状态机可用
- [ ] AC-2c: 失败分类 + 自动重试机制

### Phase 3（AI 辅助）
- [ ] AC-3a: 至少 3 个 prompt（chapter-plan/storyboard-plan/voice-script-draft）可用
- [ ] AC-3b: prompt eval suite 覆盖 5+ 个 tutorial brief
- [ ] AC-3c: AI 生成的 draft 可直接落进 video-spec

### Phase 4A（对话内生成 + 播放）— ✅ Done
- [x] AC-4Aa: provider-agnostic 接口定义（CogVideoX/Kling/Jimeng） ✅ 2026-03-28
- [x] AC-4Ab: Console BYOK 凭证绑定 + 加密存储 ✅ 2026-03-28
- [x] AC-4Ac: video rich block — 对话内直接播放生成的视频 ✅ 2026-04-01
- [x] AC-4Ad: 媒体 serve 路由 — @fastify/static + Next.js rewrite proxy ✅ 2026-04-01
- [x] AC-4Ae: 生成进度可视化 — progressBlock card on submission ✅ 2026-04-01

### Phase 4B（视频理解）— In Progress
- [ ] AC-4Ba: 猫猫能描述生成视频的内容 — 代码已就绪（gemini/zhipu 双 provider + Console 凭据桥接），待 E2E 验证
- [ ] AC-4Bb: 生成质量评估 + 重生成闭环 — 返回值含 qualityScore/issues/recommendRegenerate，但未做成对话内卡片或自动重生成链路

### Phase 4C（更多 Provider 集成）— Not Started (browser path)
- [ ] AC-4Ca: 可灵/即梦 agent-browser 调研 + 操作流程验证
- [ ] AC-4Cb: 至少 1 个 agent-browser 路径 provider 可用

### Phase 4D（视频搜索 + 平台预览）
- [ ] AC-4Da: YouTube 搜索 + Console 内预览
- [ ] AC-4Db: B站 OAuth + 搜索

## Dependencies

- **Evolved from**: F054（HCI 预热基础设施 — B 站 MCP 调研在 F054 Phase 1）
- **Absorbed**: F142（MediaHub — AI Media Generation Gateway）— 已合并入 Phase 4（KD-16）
- **Related**: F093（Cats & U 世界引擎 — 介绍视频的创意方向）
- **Related**: F066/F103（Voice Pipeline / Per-Cat Voice Identity — TTS 配音能力）
- **Related**: F139（Unified Schedule Abstraction — 任务编排基础设施）
- **External**: [waoowaoo](https://github.com/saturndec/waoowaoo)（参考架构，无 License，仅学习）
- **External**: CogVideoX API（open.bigmodel.cn）、Kling API（kling.kuaishou.com）、Jimeng API（jimeng.jianying.com）
- **External**: YouTube Data API v3、B站开放平台

## Risk

| 风险 | 缓解 |
|------|------|
| waoowaoo 无 License，代码不能直接用 | 只学习架构思路和 prompt 模板，自己实现 |
| 大视频素材导致 git 仓库膨胀 | Phase 0 就解决存储方案，schema uri 预留 `s3://` 前缀 |
| B 站 API 限制 | Phase 1 先手动上传，Phase 2 MCP 自动化 |
| AI 生成图片质量不稳定 | Phase 4 才做生成式素材，教程优先屏幕录制 |
| 教程会随产品版本腐烂 | asset-manifest 必须有 productVersion + recordedAt |
| 事实散在多处无 SSOT | video-spec snapshot 化为唯一中枢 |
| agent-browser 操作可灵/即梦脆弱 | DOM 变更/验证码/风控可能导致流程失效；标记"实验性"，API 路径备用 |
| YouTube OAuth 禁止嵌入式 UA | 必须"系统浏览器跳转回调"，不用嵌入式 webview |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | waoowaoo 仅作参考架构，不 fork/复制代码 | 无 License = all rights reserved | 2026-03-24 |
| KD-2 | Phase A 先重构现有 Remotion 代码，再考虑 AI 辅助 | 基础不牢地动山摇 | 2026-03-24 |
| KD-3 | Phase 重排：0→1→2→3→4，spec 先于队列先于 AI | GPT Pro 设计审阅建议 | 2026-03-25 |
| KD-4 | `video-spec` 而非 `storyboard` 作为中枢 schema | 教程语义字段（purpose/mustShow/locks）比分镜排列更重要 | 2026-03-25 |
| KD-5 | `voice-script` 比 `subtitle-track` 更早冻结 | 字幕是旁白的派生物，voice-script 才是源头 | 2026-03-25 |
| KD-6 | 不自建 timeline editor，先用 Remotion Studio | Remotion v4 的 schema + inputProps + Studio 已够用 | 2026-03-25 |
| KD-7 | prompt 输出必须是 JSON draft/patch，不吐 prose | "AI 说得再漂亮，只要不能落进 spec，它就只是彩带，不是齿轮" | 2026-03-25 |
| KD-8 | Phase 4 定位为"能力集成层"，不自建视频平台 | 铲屎官："像 Pencil 集成 Antigravity，不是独立做一个" | 2026-03-28 |
| KD-9 | Phase 4 执行顺序 4A→4B→4C→4D | 先对话内播放（用户感知最强），再理解/集成/搜索 | 2026-03-28 |
| KD-10 | ~~无头浏览器只做 fallback~~ → 见 KD-14 | 已被 KD-14 取代 | 2026-03-28 |
| KD-11 | Console MediaHub tab 是 provider key 唯一配置入口 | 铲屎官："能在这里填写就没必要环境配置那边保留了" | 2026-03-28 |
| KD-12 | CogVideoX API key = 智谱 API key（同一平台 open.bigmodel.cn） | 同一把 key 同时用于视频生成和视频理解（VLM），无需分别配置 | 2026-04-01 |
| KD-13 | Gemini 视频理解不需额外 API key | Gemini 已作为内建 cat 接入，直接用 cat 的多模态能力分析视频 | 2026-04-01 |
| KD-14 | 可灵/即梦用 agent-browser (Chrome MCP) 而非 Playwright/API | 铲屎官明确：API key 太贵；Cat Cafe 已有 agent-server 支持 Chrome MCP | 2026-04-02 |
| KD-15 | 可灵/即梦 API 路径降为备用 | API key 充值门槛高（可灵 10,000 RMB），分支实现保留但不作为主路径 | 2026-04-02 |
| KD-16 | F142 合并入 F138 Phase 4，不再独立维护 | 消除双真相源：F138 是唯一 SSOT，分支名 F139 为历史遗留 | 2026-04-03 |
