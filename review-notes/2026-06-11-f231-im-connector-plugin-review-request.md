# Review Request: F231 IM Connector Plugin Architecture

Review-Target-ID: f230
Branch: feat/f230-im-connector-plugin

## What

将全部 7 个 IM connector adapter 从硬编码 switch-case 迁移到统一 `IMConnectorPlugin` 接口，支持外部 npm 包动态加载。

核心变更：
1. **`im-connector-plugin.ts`** (145 行)：定义 `IMConnectorPlugin` 接口契约（id / definition / requiredEnvKeys / isConfigured / createAdapter / setup / startInbound / createWebhookHandler / createMediaDownloader）
2. **`im-connector-loader.ts`** (107 行)：内置 + 外部 npm 包加载逻辑，含接口校验
3. **`connector-gateway-bootstrap.ts`** (708 行，原 1146 行)：用统一 plugin for-loop 替换 ~560 行 7 路 per-connector inline init
4. **`im-connectors/{id}/index.ts`** × 7：每个 connector 自包含（plugin wrapper + adapter + helpers），可直接 lift into npm package
5. **Phase D adapter co-location**：删除 `adapters/` 目录，adapter 代码搬入对应 `im-connectors/{id}/` 下，git 检测为 rename（99%+ similarity，保留 blame）
6. **`examples/im-connector-example/`**：~100 行 echo connector 示例包
7. **`docs/guides/im-connector-plugin-guide.md`**：贡献者指南（接口契约 + 模式 + 开发流程）

PR 总量：52 files changed, +2391/-702

## Why

> 铲屎官原话（2026-06-11）："我不太希望我们 clowder-ai 对接一个我们在外网完全用不了的 im connector 的；如果只是插件包的话；完全可以让用户安装一下这个插件包就可以在内网用了的"

当前 connector 系统硬编码耦合 + 无法外部扩展。期望终态：`pnpm add @mycompany/connector-welink` + `IM_CONNECTOR_PLUGINS=@mycompany/connector-welink` + env 凭证 → 重启即用，主仓零改动。

## Original Requirements（必填）

> "我不太希望我们 clowder-ai 对接一个我们在外网完全用不了的 im connector 的；如果只是插件包的话；完全可以让用户安装一下这个插件包就可以在内网用了的"
> "如果我们把已有的 connector 改装成这种形式，内网弱模型只需要对着抄然后打包就好了"

- 来源：F231 spec `docs/features/F231-im-connector-plugin-architecture.md` Why 节
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

| 放弃的方案 | 放弃理由 |
|-----------|---------|
| YAML 模板化（声明式配置） | 审计 6 个 adapter 后发现每个都有重度平台专有逻辑（加密/SDK/状态机/卡片），纯 YAML 只覆盖理论上的"纯 REST webhook"场景，ROI 低（KD-1） |
| 复用 F202 Plugin Framework 的 plugin.yaml | 机制不同（F202 管 local directory plugin / 数据 pipeline；F231 管 IM transport 层），命名空间刻意分离（KD-3），后续可桥接 |
| 分 PR 按 Phase 提交 | 铲屎官指示"一次性做完"，合在一个 PR 减少集成风险 |

## Architecture Ownership（必填）

Architecture cell: connector
Map delta: update required
Why: 将现有 hardcoded adapter switch-case 改为注册表模式，新增 IMConnectorPlugin 接口契约和外部 npm 包加载点。

请 reviewer 检查：
- diff 是否与 `Map delta: update required` 一致（新增接口 + 加载器 + 注册表 = 确实改变了 connector cell 的 extension point）
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`（答案：否，复用现有 OutboundDeliveryHook / ConnectorGatewayConfig / registerDownloadFn 体系）
- 若修改 `docs/architecture/ownership/cells/*.md`，是否确实改变了 owner / boundary / extension point / canonical anchor（本 PR 未修改 cells 文件）

## Open Questions

### 技术 OQ（给 reviewer）

1. **WeakMap 状态共享模式**：每个 plugin 用 `WeakMap<IOutboundAdapter, PluginState>` 在 createAdapter / setup / startInbound / createMediaDownloader 间共享状态。是否有更好的方式？（当前选择理由：避免全局 mutable state + adapter GC 时自动清理）
2. **`configToEnvMap()` 向后兼容**：bootstrap 中保留了 `configToEnvMap()` 将 `ConnectorGatewayConfig` 字段映射回 env var name，供内置 plugin 的 `isConfigured(env)` 使用。这个桥接层是否 clean enough？
3. **Weixin/WeComBot 特殊生命周期**：Weixin 永远创建 adapter（QR login 流程）、WeComBot 支持 F136 hot-reload 动态启停。这些 special case 在 bootstrap 统一 loop 外处理——请审查这些边界是否完整。
4. **外部 plugin `import()` 安全**：只从 `IM_CONNECTOR_PLUGINS` env 显式声明的包名加载，不做 auto-scan。校验 id/definition/createAdapter/isConfigured 四项。是否足够？

### 价值 OQ（给 CVO，如有）

无。技术选型均已在 spec KD-1~KD-4 自决。

## Next Action

请 @codex 全面 review 本 PR（Draft #903），重点关注：
1. 接口设计完备性（IMConnectorPlugin 能否表达所有 7 个 connector 的需求）
2. Bootstrap 统一 loop 的正确性（原子初始化 / 错误处理 / cleanup）
3. Phase D adapter co-location 后 import path 完整性（是否有遗漏的旧路径引用）
4. 外部加载器的安全校验是否充分
5. 示例包 + 贡献者指南是否足够让弱模型照抄实现新 connector

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f230/codex`
- Start Command: `pnpm review:start`
- Ports: 本 PR 纯后端重构（无前端改动），不需要起 dev server，codex 可直接 code review

## 自检证据

### Spec 合规

- AC-A1 ✅ IMConnectorPlugin 接口定义完成（im-connector-plugin.ts, 145 行）
- AC-A2 ✅ 飞书封装为 im-connectors/feishu/index.ts（324 行）
- AC-A3 ⬜ 飞书实测待验（需要部署环境 + Feishu 凭证，@lang action）
- AC-B1 ✅ 全部 7 个 adapter 改装完成
- AC-B2 ✅ switch-case 消除，统一 plugin 接口
- AC-B3 ✅ ConnectorDefinition 动态注册表
- AC-C1 ✅ IM_CONNECTOR_PLUGINS 外部加载
- AC-C2 ✅ 示例包 examples/im-connector-example/
- AC-C3 ✅ 贡献者指南 docs/guides/im-connector-plugin-guide.md

### 测试结果

```
pnpm check                                    # 全绿（biome + feature-truth + skills-manifest + env-registry 等）
pnpm lint                                     # Done（仅 web 预存 warning，非本 PR）
pnpm --filter @cat-cafe/api test              # 14284 passed, 53 failed（全部 53 为预存失败，零 connector 相关失败）
```

预存失败清单（全部与 F231 无关）：
- audit-cc-system-prompt.test.js — missing script
- F188 cold-start eval fixtures — fixture 格式问题
- CLAUDE.md/AGENTS.md/GEMINI.md/OPENCODE.md — routing doc 检查
- plugin.yaml — PluginManifest 解析
- signal-fetcher-launchd — scheduler 相关

### 根目录工件闸门

```
git status --short | rg root artifacts  → CLEAN
git diff --name-only origin/main...HEAD | rg root artifacts → CLEAN
```

### 相关文档

- Feature: `docs/features/F231-im-connector-plugin-architecture.md`
- Guide: `docs/guides/im-connector-plugin-guide.md`
- Example: `examples/im-connector-example/`
- PR: Draft #903

---

[布偶猫/claude-opus-4-6🐾]
