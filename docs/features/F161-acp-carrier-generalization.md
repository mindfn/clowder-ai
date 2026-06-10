---
feature_ids: [F161]
related_features: [F149, F143, F050, F105, F171]
topics: [acp, carrier, generalization, runtime, env-mapping, protocol, opencode]
doc_kind: spec
created: 2026-04-13
---

# F161: ACP Carrier Generalization — 通用 ACP 传输 + 模板环境变量映射

> **Status**: in-progress | **Owner**: Ragdoll Opus-4.6 | **Priority**: P1

## Why

F149 交付了完整的 ACP runtime operations（进程池 / session lease / lifecycle / watchdog），但 ACP 传输仅 Gemini 可用——路由硬编码在 `case 'google'` 分支里，`GeminiAcpAdapter` 名字绑死 Gemini。同时 Gemini CLI 面临下线，OpenCode CLI 原生支持 ACP（`opencode acp`），团队需要让 ACP 成为通用传输协议。

核心痛点：**每加一个 ACP client 就要改 `index.ts` 路由 + `invoke-single-cat.ts` env 注入链的 if/else**。env 注入已有 5 个 protocol 分支（anthropic/openai/google/kimi/dare），每个硬编码 env var 名。

铲屎官原话（2026-06-08）：

> "我想按照想把 acp 作为独立的 provider 开放出来"
> "clientId 还是 opencode；但是新增一个可选的协议 cli/acp"
> "对于已知的哪些 client 我们可以内置 client 支持的环境变量的 key 到我们内置的环境变量的 key 的映射"

## Current State / 现状基线

| 维度 | 现状 | 证据 |
|------|------|------|
| ACP 路由 | 硬编码在 `case 'google'` 内（index.ts:1056-1100） | `getAcpConfig(id)` 只在 google 分支调用 |
| Adapter 命名 | `GeminiAcpAdapter`（Gemini 绑定） | 文件名 + class 名 |
| Env 注入 | 5 个 if/else 分支（invoke-single-cat.ts:1163-1237） | 每个 protocol 硬编码 env var 名 |
| OpenCode CLI ACP | 原生支持 `opencode acp`，Cat Cafe 未接入 | `opencode acp --help` 输出确认 |
| 通用 ACP client | 不支持 | 无 `clientId: 'acp'` 选项 |
| 底层 AcpClient/Pool | 已是 provider-agnostic | 代码审查确认无 Gemini-specific 逻辑 |

## What

### Phase A: 通用 ACP 传输 + 模板 Env 映射

**三个正交维度**：
- `clientId` = 身份（谁的 key、谁的 billing、roster 里叫啥）
- `protocol` = 传输（`cli` 默认 / `acp`）
- `acp.*` = ACP 传输配置（command、args、mcpWhitelist、pool 参数）

**改动**：

1. **Config schema**：variant 级新增 `protocol?: 'cli' | 'acp'` 字段
2. **AcpAgentService**：`GeminiAcpAdapter` 重命名为 `AcpAgentService`，metadata.provider 从配置读
3. **Registry 路由**：ACP 路由从 `case 'google'` 提升到 switch 之前——任何 clientId + `protocol: 'acp'` 都走通用 ACP 路径
4. **Env 模板映射**：新建 `env-map.ts`，定义 `BUILTIN_ENV_MAPS`（已知 client 内置映射）+ `resolveEnvMap()`（`${api_key}` / `${base_url}` 模板替换）
5. **invoke-single-cat.ts**：if/else env 注入链替换为 `resolveEnvMap()` 调用
6. **通用 ACP client**：`clientId: 'acp'` 固定 `protocol: 'acp'`，用户自配 env 映射

**Env 模板映射设计**：

```typescript
// 内置标准变量
// ${api_key}   → account binding 的 apiKey
// ${base_url}  → account binding 的 baseUrl

// 已知 client/provider 内置映射
const BUILTIN_ENV_MAPS = {
  anthropic:  { ANTHROPIC_API_KEY: '${api_key}', ANTHROPIC_BASE_URL: '${base_url}' },
  openai:     { OPENAI_API_KEY: '${api_key}', OPENAI_BASE_URL: '${base_url}' },
  google:     { GEMINI_API_KEY: '${api_key}', GOOGLE_API_KEY: '${api_key}' },
  openrouter: { OPENROUTER_API_KEY: '${api_key}' },
  kimi:       { MOONSHOT_API_KEY: '${api_key}' },
};

// 解析优先级：用户自定义 > provider 内置 > clientId 内置 > 空
```

未知 client 用户在账户/成员认证处配 `XX_CLIENT_API_KEY=${api_key}` 即可。

### Phase B: OpenCode ACP 验证（spike）

1. 验证 `opencode acp` 与 Cat Cafe ACP types.ts 协议兼容性
2. 配置 OpenCode variant：`protocol: 'acp'` + `acp.command: 'opencode'`
3. 端到端验证：prompt → ACP session → response streaming

## Acceptance Criteria

<!-- 愿景硬度自检：每条 AC trace 回 Why -->

### Phase A（通用 ACP 传输 + 模板 Env 映射）
- [ ] AC-A1: `GeminiAcpAdapter` 重命名为 `AcpAgentService`，所有引用更新，现有 Gemini ACP 功能不退化
- [ ] AC-A2: variant config 支持 `protocol: 'cli' | 'acp'` 字段；`protocol: 'acp'` 的 variant 走通用 ACP 路径，不经过 clientId switch
- [ ] AC-A3: `env-map.ts` 实现 `BUILTIN_ENV_MAPS` + `resolveEnvMap()`，已知 client 内置映射覆盖 anthropic/openai/google/openrouter/kimi
- [ ] AC-A4: `invoke-single-cat.ts` 的 env 注入 if/else 链替换为 `resolveEnvMap()` 调用，行为等价（现有测试不红）
- [ ] AC-A5: `clientId: 'acp'` 可配置，固定 `protocol: 'acp'`，用户 envVars 中的 `${api_key}` / `${base_url}` 模板变量正确替换
- [ ] AC-A6: 现有 Gemini ACP variant 加 `"protocol": "acp"` 后行为不变（向前兼容：无 protocol 字段 + 有 acp section = 隐式 ACP）

### Phase B（OpenCode ACP 验证）
- [ ] AC-B1: `opencode acp` 协议兼容性验证文档（与 types.ts 的 diff）
- [ ] AC-B2: OpenCode ACP variant 配置示例可运行，prompt→response 端到端通过

## Dependencies

- **Evolved from**: F149 Phase D（scope 收窄拆出，现扩展为完整实现）
- **Related**: F143（protocol-agnostic kernel 抽象）
- **Related**: F050（外部 agent 接入契约）
- **Related**: F105（OpenCode 金渐层接入）
- **Related**: F171（account env vars 注入机制）

## Risk

| 风险 | 缓解 |
|------|------|
| OpenCode ACP 协议与 types.ts 不兼容 | Phase B 做 spike 验证，Phase A 不依赖 OpenCode |
| env 映射重构影响现有 invocation | 保留现有测试全绿；逐步替换，不一次性删除旧路径 |
| `resolveEnvMap` 遗漏现有 env 注入的边缘 case | 逐行对照现有 if/else 链，确保每个分支都有对应映射 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | ACP 是 transport 不是 provider identity | clientId 和 protocol 正交；避免 `opencode-acp` 这种耦合设计 | 2026-06-08 |
| KD-2 | 用 `${api_key}` 模板变量替代 if/else 硬编码 | 数据驱动替代过程式，新 client 零代码接入 | 2026-06-10 |
| KD-3 | 接管 F161 而非新立 Feature | F161 spec 正是 "ACP Carrier Generalization"，避免重复立项 | 2026-06-10 |
| KD-4 | 未知 client 固定 `clientId: 'acp'`，只支持 ACP 协议 | 未知 CLI 的 event 格式无法解析，只有 ACP（标准 JSON-RPC）可通用 | 2026-06-10 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-13 | 从 F149 Phase D 拆出 F161 spec |
| 2026-06-08 | 铲屎官提出 ACP 通用接入需求，讨论设计方案 |
| 2026-06-10 | 扩展 scope（env 模板映射 + 通用 ACP client），开始实现 |
