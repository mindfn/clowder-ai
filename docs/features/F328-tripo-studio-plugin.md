---
feature_ids: [F328]
related_features: [F247, F202]
topics: [tripo, modeling, plugin, chrome, native-messaging]
doc_kind: spec
created: 2026-10-16
description: "后台读取 Tripo Studio 候选，把已选模型带回本地，服务猫猫星球建模。"
description_source: human
description_author: codex61-sol
description_updated_at: 2026-10-16T18:38:00Z
---

# F328: Tripo Studio 插件｜后台审模与资产回流

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex61-sol) | **Priority**: P1

## Why

Before：You 逐个旋转四个白模、截图、上传，让猫比较。
After：授权目标页面后，插件取得已有预览/模型，生成来源一致的比较材料；选定资产回到指定目录，接续 Blender。You 继续使用原前台。

授权：母线程 `[thread-id]` 的用户消息 `private-source-id`、`private-source-id`；批准执行线程 `[thread-id]`。原 Task `private-source-id` 留在母线程，子线程不复制、迁移。

## Current State

首轮分享链接审模已可实际使用：独立 `official.tripo-studio` v0.1.5 已经 Host 准入、启用并提供五个可调用工具；源码已通过非作者封板审查并合入 PR #5645，main merge SHA `1d953f6a10ed2a24452ae3ec64588473ac41cb39`。四个用户分享链接经已安装 v0.1.4 插件生成 16 张旋转截图；v0.1.5 另完成 C1 四图真实旅程。来源矩阵与新版实采分别标记版本；16 张比较图的来源/编号/图像 SHA-256 已回读核验。四轮 NSWorkspace 前台采样与原 Chrome 窗口/活动标签前后记录均保持；这是采样证据，不声称连续监控。此前 v0.1.3 三轮前台变化与 v0.1.0 错误取证保留为失败/不充分证据，没有改写成通过。

2026-10-16 operator 纠偏后，已按 F202 重新核定归属：Tripo 业务源码、独立构建与包发布属于 `clowder-ai-plugins`；Core 只消费版本化插件契约。Core PR #5658 正在完成去耦审查，移除本次 Tripo 业务源码、bundled 归档、专用 packer 与公开同步中的依赖准备/重建分支，只保留 `host-official-catalog.ts` 中 `official.tripo-studio` 的零 grant Host allow policy。它不提供发布坐标，也不凭空制造可安装版本。插件仓已准备独立源码包 v0.1.7，尚未发布 npm 或进入官方 catalog；Core 去耦不等待该包发布。

此前 PR #5655（main `36c37aa935f62768c47cc13d8f5cf249d7a8c485`）解决冻结源码构建依赖，并生成 Core 归档 v0.1.6；这是历史修复，现已由两仓归属纠偏取代，不再继续加固 Core 打包链。当前 Host 已加载的实例仍为 v0.1.5，其实例、配置和已有产物保留；本次不卸载、升级或重启。公开同步与最终 CI 仍由 Astra / Task062 负责，不据源码迁移或局部验证声称发布完成。

模型/比较材料留在 `/home/user/projects/cat-planet/refs/review/tripo-plugin-dogfood/`（`index.html`、`manifest.json`、`host-receipt-v0.1.5.json`（矩阵保留 v0.1.4 真实来源） 及原始 provenance）。分享页尚无可用 GLB，插件回执为 `not_exported`。母线程已通过人工下载取得 C1 并进入 Blender；该文件只核验、不复制，不能算插件正式导出完成。可选 Chrome 扩展/本机组件仍未安装或授权，不是分享链接审模的前置。

## What

单阶段独立插件，沿用 Settings 插件管理与 MCP contribution，复用 F247 framing、配对记录和 socket lease。显式授权单个 Studio 页面；只读已有候选/资源；本地检查不用 Cookie/profile 复制。不触发生成、贴图、充值、付费 API 或上传；用户保留选型。项目数据留在消费者项目。

## User Journey

已实测分享路径：Settings 安装/启用（本轮经同一 Host 的本地归档准入）→ 用户给准确分享 URL → `tripo_review_shared_model` 在新的匿名隐藏页面读取并保存比较材料 → You 选定。
可选已登录路径：猫经插件准备本机组件 → Chrome 加载扩展并在目标页面明确授权 → 猫取候选及可用预览 GLB → You 选定 → 校验后回到指定目录。该浏览器原生授权旅程及供应商正式导出仍未实测。
未授权、未连接、页面改版和资源不可用均诚实给出下一步；撤销立即阻止读取。

## Acceptance Criteria

- [x] AC-1：独立插件有完整安装包与真实可调用工具；installed/config/auth/intent/live 分开。
- [ ] AC-2：只读明确授权的 Studio 页面；不读 Cookie/profile，不接受任意脚本/URL/越界路径。
- [x] AC-3：四候选真实比较材料与来源编号一致；无真实模型不报面数或假多视图。
- [x] AC-4：前后活动窗口、标签、焦点证据证明无前台干扰。
- [ ] AC-5：已选模型回到指定目录，校验字节和来源。
- [x] AC-6：权限/契约/文件回流定向验证、一次聚焦独立审查后合入；真实旅程未完不宣称整项完成。

## 需求点 Checklist

| 需求 | AC | 验证 |
|---|---|---|
| 做个 Tripo 插件 | 1,2 | 完整安装包与授权调用 |
| 删除逐张旋转截图劳动 | 3,4 | 四候选比较与静默实测 |
| 主线是完成建模 | 5 | 真实文件回流 |
| 不过度 review、做完合入 | 6 | 定向检查与一个独立源 |

## Dependencies

Related：F247（有界本机桥接）、F202（插件管理）。Consumer：cat-planet 溪村建模；不挂 Google 专项 F327。

## Tips Contribution（F244）

已在现有 capability tip seed 贡献 Tripo 后台审模入口，指向 Settings 插件与真实授权说明。

## Implementation Evidence

Architecture cell: plugin adapter；Map delta: 新增独立 Tripo consumer；Why: 删除截图和搬运劳动。
Canonical source: `clowder-ai-plugins/packages/tripo-studio/`（业务源码、包内桥接适配、安装 manifest 与独立构建）；Core 的 `packages/api/src/domains/plugin/manager/builtin-contribution-supervisor.ts` 负责通用 MCP lifecycle，`host-official-catalog.ts` 只保留零 grant 准入策略。插件仓发布与 catalog 更新仍需各自真实回执；不把已有本地实例当成新版本已发布。

## 验证与剩余缺口

- 当前去耦候选移除 Core 的 Tripo 归档与 `pack-tripo-plugin.mjs --check` 标准 API 测试入口；独立源码包和发布验证归插件仓。已安装的 v0.1.5 保留其原交付版本和 SRI，未安装尚未发布的 v0.1.7。
- 去耦前的 64 项检查是首轮实现的历史证据，包括 Native 权限/版本、文件边界、源码漂移、空目录 consumer、Host 生命周期及包 staging；不把已删除的 Core 打包测试描述为当前入口。去耦候选另通过 44 项受影响检查，覆盖外部 catalog 归属、零 grant Host policy、现存安装实例管理、通用包 staging 与非 Tripo bundled 重建；API TypeScript、Biome 与 diff 检查通过。
- AC-2 的分享 URL/资源/来源守护与 Native 契约已验；实际 Chrome 授权、撤销及恢复旅程尚未完成，保留未勾。
- AC-4 当前只验匿名分享路径：四轮采样稳定；不为尚未授权的用户 Chrome 路径作承诺。
- AC-5 文件校验/不覆盖及已验证字节竞态已测，但插件没有取得供应商正式导出的 GLB，保留未勾。母线程人工取得的 C1 GLB 不计作此插件成果。
- SDK request cancellation 与 50 秒工作预算贯穿桥接、后台 Chrome/CDP 和整批下载；取消后清理不完整 batch 并释放 slot。真实 SDK 取消、批量预算、启动取消、Native 挂起与 CDP pending 均有 RED→GREEN 回归。
- 云端五轮采样已封板，gemini-argon 对最终 HEAD `aa87354483bc882c3ca05104ea912bf275f4807b` 完成有状态非作者终审并放行；typed fact `local-review:private-source-id:approved`。AC-6 已完成，PR #5645 已合入。Feature 仍为 in-progress，不关闭母线程 Task。

## 加载与交付边界

`main=landed:1d953f6a10ed2a24452ae3ec64588473ac41cb39`；独立插件 `live=loaded:0.1.5`，通过既有 Host 的本地不可变归档安装启用、真实调用及独立复核。归档 SRI 为 `sha512-z5iHswKOQj3qmGAz8ZtdjWjudGgc2/yZm7JfV9NmETlgt9+qY2uu8Fm7J5bjjFgq9a6oz1BA523+v85girr4Xw==`。本轮没有重启运行时；新的默认官方 catalog 注册随后续正常 Host 版本加载，不以本地已安装包代替 catalog 加载声明。

历史发布依赖修复 `main=landed:36c37aa935f62768c47cc13d8f5cf249d7a8c485` 曾生成 Core v0.1.6；该归档随 #5658 去耦候选删除，不再作为当前发布方案。新包需要在 `clowder-ai-plugins` 独立审查、构建与发布后，才能以真实版本/完整性坐标进入 catalog；没有 npm 发布或新实例加载回执。F329 所需订阅网页上传、生成、正式导出及四足动作仍在准备，当前 v0.1.5 不支持这些动作，也未替用户消耗生成积分。
