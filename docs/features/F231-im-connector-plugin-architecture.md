---
feature_ids: [F231]
related_features: [F088, F202, F132, F134, F137, F142, F151]
topics: [connector, im-connector-plugin, adapter, plugin-architecture, extensibility]
doc_kind: spec
created: 2026-06-11
---

# F231: IM Connector Plugin Architecture — 统一 IMConnectorPlugin 接口 + 外部包动态加载

> **Status**: in-progress | **Owner**: Ragdoll Opus-4.6 | **Priority**: P1

## Architecture Ownership

Architecture cell: connector
Map delta: update required
Why: 将现有 hardcoded adapter switch-case 改为注册表模式，新增 IMConnectorPlugin 接口契约和外部 npm 包加载点。

## Why

> 铲屎官原话（2026-06-11）："我不太希望我们 clowder-ai 对接一个我们在外网完全用不了的 im connector 的；如果只是插件包的话；完全可以让用户安装一下这个插件包就可以在内网用了的"

当前 connector 系统（F088）有两个问题：

1. **硬编码耦合**：`ConnectorRuntimeManager` 用 switch-case 管理 4 个 connector（feishu/dingtalk/weixin/xiaoyi），`ConnectorId` 是联合类型写死的。新增 connector 必须改主仓核心代码。
2. **无法外部扩展**：内网用户（如 WeLink、自研 IM）想对接 Cat Cafe，只能 fork 主仓改代码，无法通过安装 npm 包的方式独立扩展。

期望终态：`pnpm add @mycompany/connector-welink` + 配 `IM_CONNECTOR_PLUGINS=@mycompany/connector-welink` + 填凭证 env → 重启即可用，主仓零改动。

## Current State / 现状基线

- `ConnectorRuntimeManager.ts`：938 行，`startConnector()` 是 4 路 switch-case（L401-415）
- `ConnectorGatewayConfig`：27 个字段全部平铺在一个 interface 里（L27-50）
- `type ConnectorId = 'feishu' | 'dingtalk' | 'weixin' | 'xiaoyi'`（L46）—— 联合类型写死
- `connectorConfigured()` / `connectorSliceChanged()` / `mergeConnectorConfig()` 各有一个 4 路 switch-case
- `CONNECTOR_DEFINITIONS` 在 `connector.ts` 里是 hardcoded readonly 数组（11 项）
- 每个 adapter 代码量：飞书~1500 行、钉钉~大、微信~大、小艺~中、企微 Bot~大、企微 Agent~大
- 审计发现：6 个 adapter 都有重度平台专有逻辑（加密/SDK/状态机/卡片），纯 YAML 模板化 ROI 低

## What

### Phase A: IMConnectorPlugin 接口定义 + 飞书改装验证

定义 `IMConnectorPlugin` 接口契约。将飞书 adapter（最复杂的）改装为第一个 `IMConnectorPlugin` 实现，验证接口完备性。

关键产出：
- `im-connector-plugin.ts`：接口定义（`IMConnectorPlugin` / `PluginContext` / `InboundMessageCallback`）
- `im-connectors/feishu/index.ts`：飞书 adapter 封装为 IMConnectorPlugin export
- `im-connector-loader.ts`：内置 connector 加载逻辑
- 飞书收发消息不退化（回归验证）

### Phase B: 剩余内置 adapter 改装

将钉钉、微信、小艺、企微 Bot、企微 Agent 逐个改装为 `IMConnectorPlugin` 格式。

关键产出：
- 5 个 `im-connectors/{id}/index.ts`
- `ConnectorRuntimeManager` 去掉 switch-case，统一用 plugin 接口启停
- `ConnectorDefinition` 注册表从 hardcoded 数组改为动态 Map
- 全部 connector 收发不退化

### Phase C: 外部 npm 包加载 + 示例 + 文档

支持 `IM_CONNECTOR_PLUGINS` 环境变量动态加载外部 npm 包。

关键产出：
- `im-connector-loader.ts`：外部包 `import()` + 接口校验 + 错误处理
- `examples/im-connector-example/`：最小示例包骨架（~100 行）
- `docs/guides/im-connector-plugin-guide.md`：贡献者指南（接口契约 + 开发流程 + 测试方法）
- Hub UI 能展示外部 connector 的 definition（icon/color/name）

## Acceptance Criteria

<!-- 立项愿景硬度自检：每条 AC trace 回 Why：Why-1=消除硬编码耦合，Why-2=支持外部扩展 -->

### Phase A（接口定义 + 飞书验证）
- [x] AC-A1: `IMConnectorPlugin` 接口定义完成，包含 id/definition/requiredEnvKeys/isConfigured/createAdapter/startInbound/createWebhookHandler/createMediaDownloader 全部字段（Why-1）
- [x] AC-A2: 飞书 adapter 封装为 `im-connectors/feishu/index.ts`，export default 实现 IMConnectorPlugin（Why-1）
- [ ] AC-A3: 飞书通过 plugin 接口启动后，webhook 收消息 + 发回复 + 流式编辑 + 媒体收发 功能不退化（Why-1，验证方法：对飞书机器人发消息验证回复）

### Phase B（剩余 adapter 改装）
- [x] AC-B1: 钉钉/微信/小艺/企微Bot/企微Agent 均改装为 `im-connectors/{id}/index.ts` 格式（Why-1）
- [x] AC-B2: `ConnectorRuntimeManager` 中所有 connector-specific switch-case 被消除，统一使用 `IMConnectorPlugin` 接口（Why-1，验证方法：grep 'case.*feishu\|dingtalk\|weixin\|xiaoyi' 返回 0 结果）
- [x] AC-B3: `ConnectorDefinition` 支持运行时注册，不再是 hardcoded 数组（Why-2 前置）

### Phase C（外部加载 + 文档）
- [x] AC-C1: 设置 `IM_CONNECTOR_PLUGINS=@example/connector-test`，安装示例包后重启，connector 成功加载并出现在 Hub UI（Why-2）
- [x] AC-C2: 示例 connector 包 `examples/im-connector-example/` 包含完整骨架代码 + README，弱模型可照抄实现新 connector（Why-2）
- [x] AC-C3: 贡献者指南文档清晰描述：接口契约、env 配置、开发/调试/打包流程（Why-2）

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway — 本 feature 将 F088 的 adapter 层从硬编码改为可插拔）
- **Related**: F202（Plugin Framework — F202 管 local directory plugin，本 feature 管 npm 包级 IM connector，机制不同理念相关）
- **Related**: F132/F134/F137/F142/F151（各平台 connector 的具体 feature，它们的 adapter 代码将被改装为 IMConnectorPlugin 格式）

## Risk

| 风险 | 缓解 |
|------|------|
| 飞书 adapter 复杂度高（~1500 行），封装后可能丢失边角功能 | Phase A 专注飞书验证，跑通全功能回归再做其他 |
| 外部包 import() 可能有安全风险（任意代码执行） | 只从 env 显式声明的包名加载，不做自动扫描 |
| 接口设计第一版可能不完备 | Phase A 用最复杂的飞书吃自己的狗粮，暴露缺陷 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 外部 connector 包的 ConnectorDefinition（icon 图片）如何分发？内置走 static assets，外部包的 icon 从哪来？ | ⬜ 未定 |
| OQ-2 | 未来是否要让 IM Connector 也可通过 F202 Plugin Framework 的 plugin.yaml 声明？ | ⬜ 未定（先独立，后续可桥接） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不做 YAML 模板化，做接口+包加载 | 审计 6 个 adapter 后发现每个都有重度平台专有逻辑（加密/SDK/状态机/卡片），纯 YAML 只覆盖理论上的"纯 REST webhook"场景，ROI 低 | 2026-06-11 |
| KD-2 | 内置 adapter 也改装为 IMConnectorPlugin 格式 | 铲屎官："如果我们把已有的 connector 改装成这种形式，内网弱模型只需要对着抄然后打包就好了" | 2026-06-11 |
| KD-3 | 不叫 plugin，叫 IM Connector Plugin | 避免与 F202 Plugin Framework 的 "plugin" 命名冲突 | 2026-06-11 |
| KD-4 | PR 保持 draft，不 tracking，等外网验证 + 内网实现完整后再推进 | 铲屎官指示 | 2026-06-11 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | 立项。铲屎官确认方向：adapter 插件化 + 内置吃狗粮 + 外部 npm 包加载 |
| 2026-06-11 | Phase A ✅ 接口定义 + 飞书改装（im-connector-plugin.ts + feishu/index.ts） |
| 2026-06-11 | Phase B ✅ 全部 7 个 adapter 改装 + bootstrap 统一 plugin 循环（1146→708 行） |
| 2026-06-11 | Phase C ✅ 外部加载器 + 示例包 + 贡献者指南（AC-A3 飞书实测待验） |

## Review Gate

- Phase A: 跨族 review（缅因猫）— 重点验证接口设计完备性
- Phase B: 跨族 review — 重点验证无退化
- Phase C: 跨族 review + 铲屎官内网试用验证

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F088-multi-platform-chat-gateway.md` | 原始 connector 系统 spec |
| **Feature** | `docs/features/F202-plugin-framework.md` | 通用 Plugin Framework（相关但独立） |
| **Codebase** | `packages/api/src/infrastructure/connectors/` | 现有 connector 代码（relay-claw） |
