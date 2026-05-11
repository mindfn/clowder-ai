# F197: Plugin Framework — 声明式插件注册与资源编排

> **Status**: spec (rev4 — 整合 @codex 三轮复核)
> **Owner**: Ragdoll (宪宪/Opus-46)
> **Reviewer**: Maine Coon (砚砚/GPT-5.5)
> **Priority**: P1
> **Created**: 2026-05-12

## 问题

当前系统中 Skill、MCP、Limb、定时任务各自独立管理，缺少"插件"这个聚合单元：

1. **无法一键启用**——配一个微信公众号要分别配凭证、手动确认 limb 注册、检查 skill 是否可见
2. **无法动态扩展**——社区用户想加一个平台集成，必须改代码（hardcode 在 `CONNECTOR_PLATFORMS` 或 `index.ts`）
3. **资源间依赖不可见**——skill 依赖 limb/MCP，但 UI 上看不出来，用户不知道为什么某个 skill 不可用
4. **GitHub 等已有集成是"裸配置"**——没有统一的插件抽象，每个集成的配置/状态/UI 都是定制的

## 方案

### 插件 = 目录 + 声明 + 资源

```
plugins/
├── weixin-mp/
│   ├── plugin.yaml           # 插件声明（唯一真相源）
│   ├── icon.svg              # 可选：自定义图标
│   ├── limbs/
│   │   └── weixin-mp.yml     # Limb 定义
│   └── skills/
│       └── weixin-mp.md      # Skill 文件
├── github/
│   ├── plugin.yaml
│   └── skills/
│       └── github-ops.md
└── community-example/        # 社区用户的插件
    ├── plugin.yaml
    └── skills/
        └── custom-workflow.md
```

### plugin.yaml Schema

```yaml
# 必填
id: weixin-mp                              # 全局唯一 ID
name: 微信公众号                             # 显示名
version: "1.0.0"

# 可选
description: 公众号文章发布与素材管理
icon: icon.svg                              # 自定义图标，缺省用 UI 默认

# 凭证/配置项（唯一真相源——资源不自带凭证，引用这里的 env vars）
config:
  - envName: WEIXIN_MP_APP_ID
    label: App ID
    sensitive: false
    required: true
  - envName: WEIXIN_MP_APP_SECRET
    label: App Secret
    sensitive: true
    required: true

# 健康检查（可选——声明了才在 UI 显示"测试连接"按钮）
# 只允许 limbCommand 或 mcpProbe，不允许任意 HTTP（防 SSRF）
healthCheck:
  limbCommand: weixin_mp.check_status       # 通过 limb invoke 检查

# 插件提供的资源（不含凭证——凭证统一在 config 声明）
resources:
  - type: limb
    path: limbs/weixin-mp.yml
  - type: skill
    path: skills/weixin-mp.md
  # - type: mcp
  #   name: my-mcp-server
  #   command: node
  #   args: ["server.js"]
  #   transport: stdio
  # - type: schedule
  #   path: schedules/token-refresh.yaml
```

### 资源类型与生命周期

| type | 含义 | 启用时 | 禁用时 |
|------|------|--------|--------|
| `skill` | Agent 技能 | mount/symlink 到 provider skill dirs + 写入 CapabilityEntry（`pluginId` 元数据）| 移除 symlink + CapabilityEntry 标记 `enabled: false`（豁免 prune）|
| `mcp` | MCP Server | 写入 CapabilityEntry → `generateCliConfigs()` → probe | 从 capabilities 移除 → 重新生成 CLI configs |
| `limb` | Limb 节点 | 加载 YAML → 实例化 adapter → `LimbRegistry.register()` + CapabilityEntry | `LimbRegistry.deregister()` + CapabilityEntry 移除 |
| `schedule` | 定时任务 | 注册到 PackTemplateStore | 移除模板，停止运行中实例 |

### 状态真相源（rev2 修正）

**不新建 `plugin-state.json`**。插件状态由三个已有源派生：

```
插件状态 = f(manifest, capabilities.json, env)

- manifest (plugins/xxx/plugin.yaml) → 声明了哪些资源
- capabilities.json → 资源是否 enabled（含 pluginId 元数据）
- env (.env / .env.local) → 凭证是否已配置

派生规则：
- 所有 required config 都有值 → "已配置"
- 所有声明的资源在 capabilities.json 中 enabled → "已启用"
- 以上都不满足 → "未配置"
```

**PluginRegistry 只做发现和编排，不持有状态。**

### 凭证管理（rev2 修正）

现有 `/api/config/secrets` 有硬编码 `CONNECTOR_SECRETS_ALLOWLIST`。社区插件不能依赖改代码加 allowlist。

**方案：新增 `POST /api/plugins/:id/config`**

- 只允许写入该插件 `plugin.yaml` 中声明的 `config[].envName`
- 底层复用 `.env.local` 写入逻辑

**env name 安全边界（rev4 修正）**：

denylist 无法穷举所有危险变量（会漏掉 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等现有凭证）。改用三层防御：

1. **插件 ID 前缀约束**（社区插件强制，内置插件豁免）：
   - 社区插件的 envName 必须以 `{PLUGIN_ID_UPPER}_` 开头（如插件 `weixin-mp` → `WEIXIN_MP_*`）
   - 内置插件（代码内 `BUILTIN_PLUGIN_IDS` 白名单，`plugins/` 目录保留 ID 被 registry 拒绝）豁免前缀约束（允许 `GITHUB_TOKEN` 等历史命名）
   - manifest 扫描阶段校验，违反 → 插件加载失败
2. **系统变量 denylist**（所有插件适用）：
   - `CAT_CAFE_*`、`REDIS_*`、`DATABASE_*` — 存储/运行时
   - `API_SERVER_*`、`FRONTEND_*`、`PREVIEW_*` — 端口
   - `NODE_OPTIONS`、`NODE_ENV`、`PATH`、`HOME`、`SHELL` — 系统
   - `AGENT_KEY_*`、`JWT_*`、`SESSION_*` — 鉴权
3. **跨插件碰撞检测**：同一 envName 不能被两个插件同时声明（manifest 扫描阶段即拒绝后加载的插件）

```
POST /api/plugins/weixin-mp/config
Body: { "updates": [{ "name": "WEIXIN_MP_APP_ID", "value": "wx123..." }] }

校验链：
  WEIXIN_MP_APP_ID ∈ manifest.config → ✓
  WEIXIN_MP_APP_ID ∉ system denylist → ✓
  WEIXIN_MP_APP_ID 未被其他插件声明 → ✓
  → 允许写入

反例：
  REDIS_URL → 命中 system denylist → manifest 加载即拒绝
  OPENAI_API_KEY → 社区插件前缀不匹配 → manifest 加载即拒绝
  WEIXIN_MP_APP_ID 被两个插件声明 → 碰撞检测 → 后者加载失败
```

### MCP 资源生命周期（rev2 修正）

MCP 不是由 API 进程直接管理长驻进程。实际路径是：

```
插件启用（MCP 资源）
  → 写入/更新 CapabilityEntry (type: 'mcp', pluginId, descriptor)
  → generateCliConfigs() 重新生成各 agent/provider 的配置文件
  → probe 验证可达性
  → 已运行的 agent session 需要重启才能加载新 MCP

插件禁用
  → 从 capabilities.json 移除该 MCP entry
  → regenerate CLI configs
  → 已运行 session 下次重启时不再加载
```

### Limb 与 MCP 的关系（rev2 澄清）

Limb 通过 `limb_invoke` MCP tool 暴露给 agent。但 `LimbRegistry` 是 API 进程内的运行时 registry，不同于 MCP 进程。

- **Limb 型资源**：PluginRegistry 在 API 启动时加载 YAML → 通过 adapter factory 实例化（YAML 中需有 `adapter: weixin-mp` 指向内置 adapter 类）→ 注册到内存 `LimbRegistry`。这是 API 进程内操作，不走 MCP 进程管理。Phase 1 只支持内置 adapter（代码中注册的 factory）；社区插件需要自定义 adapter 时需贡献 adapter 代码。
- **MCP 型资源**：走 capabilities.json → CLI config 生成。是独立进程。
- 两者不混用。一个插件可以同时声明 limb + mcp 资源，但它们是不同的激活路径。

### Skill 激活路径（rev2 修正）

当前 `/api/skills` 扫描 `cat-cafe-skills/` 目录和 `manifest.yaml`。插件 skill 的激活方式：

1. 启用插件时，将 skill 文件 symlink 到各 provider 的 skill 目录（或扩展 scan source 包含 `plugins/xxx/skills/`）
2. 在 `CapabilityEntry` 中写入 `pluginId: "weixin-mp"` 元数据
3. Skill UI 查询 `pluginId`，如果对应插件未启用 → 灰显 "需先启用「微信公众号」插件"

**禁用语义（rev4 修正）**：

现有 skill 加载是 filesystem discovery（`listSkillDirs` 扫描 symlink），symlink 存在 = agent 可见/可加载，`CapabilityEntry.enabled` 不能阻止加载。因此禁用时必须移除 symlink。

- **禁用**：移除 provider skill dir 中的 symlink + CapabilityEntry 标记 `enabled: false, pluginId: "weixin-mp"`
- **prune 豁免**：plugin-owned entry（有 `pluginId`）不参与 filesystem prune（正常 prune 会删除文件系统不存在的 skill entry）
- **UI 灰显**：Skill UI 从 CapabilityEntry 读取 `pluginId` + `enabled: false` → 灰显 + 提示"需先启用「微信公众号」插件"
- **重新启用**：重建 symlink + CapabilityEntry `enabled: true`
- **完全卸载（未来）**：删 CapabilityEntry

### 健康检查（rev2 修正）

**删除 `httpGet` 选项**（防 SSRF / localhost 端口探测）。只保留：

- `limbCommand`: 通过已注册 limb 节点的 command 检查
- `mcpProbe`: 通过已注册 MCP server 的 probe 检查

```yaml
healthCheck:
  limbCommand: weixin_mp.check_status    # OK: 走 LimbRegistry
  # httpGet: ...                         # 禁止: SSRF 风险
```

**scope 约束（rev3 新增）**：`healthCheck.limbCommand` 只能调用同插件声明的 limb 资源中的 command。系统校验 nodeId 匹配该插件 resources 中的 limb 声明，防止测试按钮触发其他插件的 limb 或副作用命令。

### 启用/禁用事务（rev2 新增）

启用多资源需要事务语义。如果部分资源激活失败：

1. 已成功激活的资源保留（不全部回滚——避免因一个 skill 文件缺失导致整个插件不可用）
2. 返回部分成功状态：`{ status: "partial", resources: [{ type: "limb", ok: true }, { type: "skill", ok: false, error: "..." }] }`
3. UI 显示哪些资源成功、哪些失败
4. 用户可重试（`POST /api/plugins/:id/enable` 是幂等的）

### 运行时生命周期（rev2 修正）

```
                    发现                          配置                    启用
plugins/ 目录 ──→ PluginRegistry.scan() ──→ UI 填凭证 ──────→ plugin.enable()
                                            ↓                         ↓
                                POST /api/plugins/:id/config    事务性遍历 resources[]
                                  (只允许 manifest 声明的          ├→ skill: symlink + CapabilityEntry(pluginId)
                                   envName)                       ├→ mcp: CapabilityEntry → generateCliConfigs() → probe
                                                                  ├→ limb: load YAML → adapter → LimbRegistry.register()
                                                                  └→ schedule: templateStore.register()
                                                                  ↓
                                                            返回每个资源的激活结果
```

**发现机制（启动时）**：
1. 扫描 `plugins/` 目录下所有 `plugin.yaml`
2. 校验 schema，跳过非法声明（log warning）
3. 从 `capabilities.json` 查询哪些插件资源已 enabled → 派生插件状态
4. 已启用的插件自动重新激活资源（limb 重注册、skill 重 mount）

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plugins` | 列出所有已发现插件（状态从 manifest + capabilities + env 派生） |
| GET | `/api/plugins/:id` | 单个插件详情（含每个资源的状态） |
| POST | `/api/plugins/:id/enable` | 启用（事务性激活资源，写入 capabilities.json）|
| POST | `/api/plugins/:id/disable` | 禁用（按资源类型注销/标记 disabled/移除 symlink）|
| POST | `/api/plugins/:id/config` | 写入凭证（只允许 manifest 声明的 envName）|
| POST | `/api/plugins/:id/test` | 测试连接（仅当声明了 `healthCheck`） |

### UI（Settings > 插件/集成）

```
┌─────────────────────────────────────────────────┐
│  插件 / 集成                                      │
├─────────────────────────────────────────────────┤
│  [🟢] GitHub            已连接    [配置 ▾]       │
│  [⚪] 微信公众号          未配置    [配置 ▾]       │
│       ├─ App ID: [___________]                   │
│       ├─ App Secret: [***]                       │
│       └─ [测试连接] [保存并启用]                    │
│  [⚪] 微博               未配置                    │
│  [⚪] 小红书              未配置                    │
└─────────────────────────────────────────────────┘

Settings > Skill 管理
┌─────────────────────────────────────────────────┐
│  weixin-mp     灰显 · 需先启用「微信公众号」插件    │
│  github-ops    ✓ 可用                            │
│  pencil-design ✓ 可用                            │
└─────────────────────────────────────────────────┘

Settings > MCP 管理
┌─────────────────────────────────────────────────┐
│  my-plugin-mcp  [来自: my-plugin 插件]            │
│  env: MY_API_KEY = sk-****  (from plugin config) │
└─────────────────────────────────────────────────┘
```

## Phase 分解

### Phase 1：插件框架（发现 + 配置 + 资源激活）

**目标**：建立通用插件框架——`plugins/` 目录放 `plugin.yaml` 即可被系统发现、配置、启用，资源自动激活。

**后端：**
- `PluginRegistry` — 扫描 `plugins/` 目录、解析 manifest、校验 schema（只做发现/编排，不持有状态）
- `PluginResourceActivator` — 按 resource type 分发到各 registry（事务语义，部分失败可重试）
- `POST /api/plugins/:id/config` — plugin-scoped 凭证写入（只允许 manifest 声明的 envName，不放开任意 env）
- `POST /api/plugins/:id/enable` / `disable` — 触发资源激活/注销，写入 `capabilities.json`（含 `pluginId` 元数据）
- MCP 资源走 CapabilityEntry → `generateCliConfigs()` → probe 路径
- Limb 资源走内存 `LimbRegistry.register()` + CapabilityEntry
- Skill 资源走 symlink/scan-source 扩展 + CapabilityEntry（`pluginId`）
- `GET /api/plugins` — 返回插件列表（状态从 manifest + capabilities + env 派生）

**前端：**
- `PluginsContent.tsx` 改造——从硬编码 `PLUGIN_CATALOG` → 动态从 `GET /api/plugins` 拿数据
- 通用 `PluginConfigPanel` 组件——根据 `config` 字段自动渲染表单
- 启用/禁用按钮 + 资源激活结果展示 + 可选测试按钮
- Skill 管理 UI：查询 `pluginId`，插件未启用时灰显
- MCP 管理 UI：插件提供的 MCP server env 可见（sensitive 脱敏）

**验收：**
1. 放一个只有 config + skill 的空插件 → UI 展示配置面板 → 保存凭证 → 启用后 skill 可见
2. 放一个有 limb 的插件 → 启用后 limb 注册 + CapabilityEntry 写入 → Skill UI 联动
3. 禁用 → skill symlink 移除 + CapabilityEntry(enabled:false) 保留 → skill 灰显
4. 部分资源激活失败 → UI 显示哪些成功哪些失败 → 可重试

### Phase 2：具体插件适配（微信公众号 + 其他）

**目标**：基于 Phase 1 框架，实现具体插件。

**微信公众号插件：**
- 将已有的 `limbs/weixin-mp.yml`、`cat-cafe-skills/weixin-mp.md` 迁移到 `plugins/weixin-mp/`
- 编写 `plugins/weixin-mp/plugin.yaml`
- 已有后端代码（`WeixinMpLimbNode`、`weixin-mp-client`、`weixin-mp-token`）保持不变
- 从 `index.ts` 移除硬编码的 limb 注册，改为插件驱动
- 端到端验证：配置凭证 → 启用 → limb 在线 → skill 可用 → 猫猫可调用

**其他插件（并行）：**
- 基于 MCP 的插件——用同一个 `plugin.yaml` 声明 MCP resource + config
- GitHub 迁移——将现有 GitHub 集成封装为插件

**验收**：铲屎官在 Settings 配好插件凭证 → 一键启用 → 对应资源自动可用。

## 不做

- 热加载（先重启发现，热加载是后续优化）
- 远程插件市场 / 在线安装
- 插件间依赖声明（`depends_on` 等）
- 插件沙箱 / 权限隔离
- Hook 资源类型的执行引擎（schema 预留 `type: hook`，执行在未来 feature）
- `healthCheck.httpGet`（SSRF 风险，只允许 limbCommand / mcpProbe）

## 现有基础设施复用

| 已有 | 用途 |
|------|------|
| `capabilities.json` + `CapabilityOrchestrator` | 资源启用状态真相源 + 审计 + CLI config 生成 |
| `.env.local` 写入逻辑 | plugin-scoped 凭证写入（新端点包装） |
| `LimbRegistry` + `LimbAccessPolicy` | Limb 节点运行时管理与授权 |
| `generateCliConfigs()` | MCP 资源激活后重新生成 agent 配置 |
| `PackTemplateStore` + `GlobalControlStore` | 定时任务模板与调度 |
| `PluginsContent.tsx` + `GithubConfigPanel.tsx` | F190 插件 UI 骨架 |
| Skill scan source (`cat-cafe-skills/`) | 扩展 scan 路径包含 plugin skills |

## 关键设计决策

1. **声明式 > 命令式**——插件声明资源让系统管理，不运行代码注册
2. **目录发现 > 数据库**——git 友好，社区用户 PR 一个目录就是一个插件
3. **复用已有 registry**——PluginRegistry 只做发现/编排，状态写入 `capabilities.json`，不另建状态系统
4. **config 驱动通用 UI**——不需要为每个插件写 React 组件
5. **凭证单一真相源**——`config` 声明 env vars，通过 plugin-scoped 端点写入，MCP/Limb 不自带凭证
6. **plugin-scoped config 端点**——不动现有 `CONNECTOR_SECRETS_ALLOWLIST`，新端点只允许写入该插件声明的 envName
7. **Limb ≠ MCP 进程**——Limb 是 API 内存 registry（通过 `limb_invoke` 暴露），MCP 是独立进程（通过 CLI config 管理）。两者激活路径不同，不混用
8. **启用事务是幂等部分成功**——不全部回滚，返回每个资源的结果，可重试

## Review 记录

### rev2 (2026-05-12) — @codex 架构评估

| Finding | 级别 | 修正 |
|---------|------|------|
| `plugin-state.json` 和现有 capabilities 漂移 | P1 | 删掉，状态从 capabilities.json + manifest + env 派生 |
| secrets allowlist 硬编码冲突 | P1 | 新增 `POST /api/plugins/:id/config`，plugin-scoped |
| MCP 生命周期绕过 capabilities 写路径 | P1 | 改走 CapabilityEntry → generateCliConfigs() → probe |
| limb/mcp 关系含混 | P2 | 明确分层：limb = API 内存 registry，MCP = 独立进程 |
| Skill 没有 `CapabilityStore.enable()` | P2 | 走 symlink/scan-source 扩展 + CapabilityEntry(pluginId) |
| `healthCheck.httpGet` SSRF 风险 | P2 | 删掉，只保留 limbCommand / mcpProbe |

### rev3 (2026-05-12) — @codex 二轮复核

| Finding | 级别 | 修正 |
|---------|------|------|
| plugin config 可声明危险 env（REDIS_URL 等） | P1 | 全局保留前缀 denylist，manifest 扫描阶段即拒绝 |
| skill 禁用后被 filesystem prune 导致无法灰显 | P2 | plugin-owned skill 保留 CapabilityEntry(enabled:false)，豁免 prune |
| limb adapter factory 缺失 | P2 | YAML 加 `adapter` 字段，Phase 1 只支持内置 adapter |
| healthCheck.limbCommand 无 scope 约束 | P2 | 限制只能调用同插件声明的 limb 资源中的 command |

### rev4 (2026-05-12) — @codex 三轮复核

| Finding | 级别 | 修正 |
|---------|------|------|
| env denylist 无法穷举（漏 OPENAI_API_KEY 等现有凭证） | P1 | 三层防御：社区插件 ID 前缀约束 + system denylist + 跨插件碰撞检测 |
| skill 禁用保留 symlink 但 agent 仍加载（filesystem discovery） | P1 | 禁用时移除 symlink，CapabilityEntry(enabled:false) 豁免 prune，UI 用 entry 灰显 |
| `LimbRegistry.unregister()` 术语不一致 | P3 | 统一为 `deregister()`（与现有代码一致） |
