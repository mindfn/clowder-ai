---
feature_ids: [F202]
topics: [plugin-framework, train-c1, migration, connector, cutover]
doc_kind: plan
created: 2026-09-19
architecture-cell: plugin
---

# F202 Train C1 — 冻结 inventory、安全契约与两仓串行计划（Phase 1 交付）

> 本文是 Train C1 的实施前计划，不是实现。结论全部 code-derived at the frozen baseline。

> **车道边界（2026-09-19 scope correction）**：本计划只承载 **Core deletion-dominant lane**。
> Plugins 聚合迁移由独立 thread `thread_mrkn6povq4zzgh45` 拥有，其冻结的 11 行 C1 migration set
> 是本计划的**输入**（§2.0），不是本计划的实施范围；本 worktree 不写 Plugins 业务代码。
> TTS/ASR 与任何新 public hook / UI slot 属于 C2，不混入 C1。

## 1. 冻结基线

| 仓 | 精确坐标 | 说明 |
|---|---|---|
| Core `zts212653/clowder-ai` | `9ab0eaf287381efcb209781463f38cc5f23870ea` | 即 Train B Core 聚合 PR #1477 的 merge commit |
| Plugins `zts212653/clowder-ai-plugins` | `123112c3e7458b09eab28c201deeb018a0173503` | Train B Plugins 聚合 PR #45 之后的 main |

已发布物（npm `next`）：`@clowder-ai/plugin-contract` `0.1.0-beta.16`、`@clowder-ai/plugin-sdk`
`0.1.0-beta.11`、`@clowder-ai/video-analysis` `0.1.0-alpha.1`（Train B 真实消费者，digest-matched）。

Train B 进入条件已满足：Plugins #45 与 Core #1477 均已合入，maintainer APPROVED（review `5250628473`）。

## 2. 冻结 inventory（INV-R2 全量守恒）

roadmap §6.4 的 census 日期为 2026-08-25。本次在冻结基线上**重新 code-derive**，不照抄旧清单。
INV-R2 规定"沉默遗漏不等于排除"，因此下表把新发现 entry 显式列入并标注 disposition。

### 2.0 C1 migration set — 11 行（Plugins owner thread 已冻结）

权威来源：Plugins owner thread 在 Core `9ab0eaf287381efcb209781463f38cc5f23870ea` + Plugins
`123112c` 上冻结该集合并置于 RED contract 之下。**Core 侧按这 11 行推导 config/binding/data 映射
与删除面，不自行增删。**

| # | package | catalog id | 本文对应节 |
|---|---|---|---|
| 1 | `@clowder-ai/connector-dingtalk` | `official.connector.dingtalk` | §2.1 |
| 2 | `@clowder-ai/connector-feishu` | `official.connector.feishu` | §2.1 |
| 3 | `@clowder-ai/connector-telegram` | `official.connector.telegram` | §2.1 |
| 4 | `@clowder-ai/connector-wecom-agent` | `official.connector.wecom-agent` | §2.1 |
| 5 | `@clowder-ai/connector-wecom-bot` | `official.connector.wecom-bot` | §2.1 |
| 6 | `@clowder-ai/connector-weixin` | `official.connector.weixin` | §2.1 |
| 7 | `@clowder-ai/connector-xiaoyi` | `official.connector.xiaoyi` | §2.1 |
| 8 | `@clowder-ai/github-operations` | `official.github-operations` | §2.2 |
| 9 | `@clowder-ai/video-generation` | `dev.clowder.video-generation` | §2.2 |
| 10 | `@clowder-ai/wechat-visible-reader` | `official.wechat-visible-reader` | §2.2 |
| 11 | `@clowder-ai/weixin-mp` | `official.weixin-mp` | §2.2 |

**三个 external baseline —— 不是 migration row，但各自的 Core cutover/delete 义务不同。**
它们的共同点只有"Plugins 侧不需要重新迁移"；发布状态与 Core 侧动作必须逐项区分，
不能一句"已发布的消费者证据"带过（该表述对 Personal Chrome 不成立）。

| baseline | 冻结树中的发布状态 | Core C1 义务 |
|---|---|---|
| `video-analysis` | **已发布** `0.1.0-alpha.1`；catalog 有 `dev.clowder.video-analysis` 行 | **有删除面，且今天未删**：Core 切到 alpha.1 外部包，并删除 `packages/api/src/plugins/` 下的 repository-local duplicate。`index.ts:5027-5032` 的 `replacesRepositoryPluginId` 策略已在位，**但它只抑制 Plugin Manager 列表、不做运行时替换**（§7.4.0 第 3 条）——repo-local 实现今天完整存在且 toolset 仍注册，故删除是 parity 验收的**前置**而非收尾（§7.4.3 第 6 条） |
| `personal-chrome-companion` | **未发布**——`packages/personal-chrome-companion/README.md:42`"This package is a review candidate only. It does not publish to npm or the Chrome Web Store"；catalog **无**该行 | **拆成两半**：可外置的 extension / native-host payload 跟随 Plugins 车道，**不在 C1**；Host 侧 installer / pairing / Settings / receipt authority **保留且删除面必须绕开**（§2.2） |
| `feishu-meeting-intake` | 已有独立 npm/stdio package（roadmap §2.1 记 `next = 0.1.0-alpha.9`）；catalog 无该行 | **无删除面**：既有 package 继续存在，Core 侧保留其 Host wiring，不迁移不删除 |

把这三行计入 11 行 migration set 会虚增 C1 范围；反过来，把它们一律标成"无 Core 动作"
会漏掉 `video-analysis` 的 duplicate 删除——两个方向都是错的。

**Core 保留的 Host truth（不随 provider 实现一起删）**：inventory/grants/config/secrets、
connector-thread bindings、durable cursor/checkpoint 与 dedup state、delivery retry/dead-letter、
通用 schedule/webhook activation、lifecycle 与 no-double-run 开关。

> **这一行说的是归属，不是现状实现度**（第九轮 review 精确化）：它规定这些面**留在 Host、不随
> provider 实现一起删**，不代表每一项在冻结基线上都已有持久实现。code-derived 现状：
> `MessagingLedger` 的 `idempotencyKey` 幂等门**是持久的**（`ledger.ts:12`：claim TTL 60s、
> settled 保留 7 天）；connector 入站 dedup 目前是**进程内** `Map`（`InboundMessageDedup.ts:6`），
> 重启即失忆；**声明式 checkpoint 面今天不存在**（缺口 E）。E 的新 ABI 设计不在 C1（§7.3），
> 重启行为因此逐 provider 用 package parity 证据验（§5.3 connector 行删除门）。

### 2.1 IM providers — 7 项，与旧清单精确一致（无静默新增）

枚举源：`packages/api/src/infrastructure/connectors/im-connector-loader.ts:22-30`（硬编码 7 元
`Promise.all`），与 7 个 `connector.yaml`、7 个 `IMConnectorPlugin` 默认导出模块三方互证。

| entry | 代码 owner | 配置/secret | 自有持久数据 | 专属 journey |
|---|---|---|---|---|
| `feishu` | `im-connectors/feishu/`（1723 LOC） | `FEISHU_APP_ID/APP_SECRET/VERIFICATION_TOKEN/CONNECTION_MODE/BOT_OPEN_ID/ADMIN_OPEN_IDS/GROUP_BOT_MENTIONS_JSON` | `.cat-cafe/im-connector-config/feishu.json`（含 `_operations.feishu_qr_login`）；`connector-binding:feishu:*`；`connector-perm{,-groups}:feishu` | `connector-hub.ts` 3 条 QR 路由；guide `connect-feishu.yaml` |
| `weixin` | `im-connectors/weixin/`（2057 LOC） | `WEIXIN_BOT_TOKEN` + 3 个直读 `process.env` 的 voice 变量 | Redis `connectors:weixin:session-state`（长轮询游标 + context tokens）；`weixin.json`（含 `_operations.weixin_qr_login`）；`connector-binding:weixin:*` | `connector-hub.ts` 4 条路由；guide `connect-wechat.yaml` |
| `wecom-bot` | `im-connectors/wecom-bot/`（1151 LOC） | `WECOM_BOT_ID/SECRET` | Redis set `wecom-bot-group-chat-ids`；`wecom-bot.json`（含 `_operations.wecom_validate`）；binding + perm | `connector-hub.ts` 2 条路由 |
| `dingtalk` | `im-connectors/dingtalk/`（1079 LOC） | `DINGTALK_APP_KEY/APP_SECRET` | Redis set `dingtalk-group-chat-ids`；config + binding + perm | 无 |
| `wecom-agent` | `im-connectors/wecom-agent/`（853 LOC） | `WECOM_CORP_ID/AGENT_ID/AGENT_SECRET/TOKEN/ENCODING_AES_KEY` | config + binding | 无（走通用 webhook；但 XML content-type parser 专为它加在共享路由 `connector-webhooks.ts:51-66`） |
| `telegram` | `im-connectors/telegram/`（896 LOC） | `TELEGRAM_BOT_TOKEN` | config + binding | 无（但 token 校验规则硬编码进 Core `connector-secret-write-guards.ts`） |
| `xiaoyi` | `im-connectors/xiaoyi/`（714 LOC） | `XIAOYI_AK/SK/AGENT_ID` | config + binding（chatId = `{agentId}:{sessionId}`） | 无 |

### 2.2 repository-local business plugins — 4 项在 C1 migration set，1 项为既有 baseline，**另发现 1 项静默新增**

manifest 根：`packages/api/src/plugins/`（`index.ts:4317` 硬编码）；枚举器 `PluginRegistry.scan()`。

| entry | 资源声明 | 配置/secret | 自有持久数据 | disposition |
|---|---|---|---|---|
| `github` | 7 个 schedule | `GITHUB_TOKEN`、`GITHUB_MCP_PAT`、`GITHUB_SETUP_NOISE_BOT_LOGINS` | `schedule:github:*` ×7；`capabilities.json` ownership；迁移标记 `.cat-cafe/f202-phase2-github-schedule-migrated`、`.cat-cafe/f168-github-schedule-backfilled`；Redis `community:repo-comment:cursor:{repo}` | in-scope C1 |
| `video-analysis` | 1 个 mcp | 5 个 `VIDEO_ANALYSIS_*` | `capabilities.json` + 生成的 CLI MCP config | **既有 external baseline，非 C1 migration row**（alpha.1 已发布，`index.ts:5027-5032` 的 `replacesRepositoryPluginId` 策略已在位——**仅列表抑制，非运行时替换**，见 §7.4.0 第 3 条）；**但有 Core 删除面且今天未删**：切到 alpha.1 外部包并删除本地 duplicate（§2.0 baseline ledger、§5 Stage 4 第 5 步、§7.4.3 第 6 条） |
| `video-gen` | 1 个 mcp | 7 个 `VIDEO_GEN_*` | 同上 | in-scope C1 |
| `weixin-mp` | limb + skill | `WEIXIN_MP_APP_ID/APP_SECRET` | `capabilities.json` ×2；skill 挂载副作用（跨项目级联）；限时 access token | in-scope C1 |
| `wechat-visible-reader` | limb | 无 | 仅内存 arm 授权窗口（无持久化） | in-scope C1 |
| **`personal-chrome-host`** ⚠ | **无 `plugin.yaml`** | 5 个 `CAT_CAFE_PERSONAL_CHROME_*`（env-only，不走 plugin config 边界） | **自有目录** `.cat-cafe/plugin-host/personal-chrome-host/{pairing,conversation-binding,delivery-ledger}.json`；Unix socket | **非 C1 migration row**；Host authority 受保护（§2.2 裁定） |

`personal-chrome-host` 位于 manifest 根目录内（`plugins/cloud-cat-personal-host/`），以
`pluginId: 'personal-chrome-host'` 对外呈现，拥有独立 `/api/plugins/personal-chrome*` 路由与
独立 Settings 面板，但因无 `plugin.yaml` 被 `PluginRegistry.scan()` 静默跳过
（`PluginRegistry.ts:59-60`）。**任何以 `find -name plugin.yaml` 为准的 census 都会漏掉它。**

**裁定（reviewer ruling，2026-09-19）：既不是 C1 migration row，也不是 `PluginManifest` / installer。**
权威依据是 Plugins roadmap §2.2「成熟度判断 · 存量迁移」行——"Feishu/Chrome 是外部 package 先例"，
即 Chrome 路径被列为**既有先例**而非待迁移项；`docs/architecture/ownership/cells/plugin.md:131` 同样
把它定性为 "one concrete, explicitly user-installed adapter"。

> **勘误**：本文初版在此引用"roadmap §2.1 已将 Personal Chrome 列为'既有独立候选…'"。roadmap §2.1
> 是「精确坐标」表，不含该表述——该引用不成立，已替换为上述可核验来源。

因此 Core C1 的删除面**必须显式绕开**它：安装、配对、Settings 面板与 receipt authority 仍归 Host，
不得随旧通用 plugin 管理面一并删除（§5 Stage 4 已加排除项）。

### 2.3 第二处静默缺口 — enterprise workflow 的 provider-specific 实现

`packages/api/src/infrastructure/enterprise/` 下的 `LarkActionService.ts`、`LarkCliExecutor.ts`、
`WeComActionService.ts`、`WeComCliExecutor.ts` 及回调路由 `callback-lark-action-routes.ts`、
`callback-wecom-action-routes.ts`，是 Feishu/WeCom **平台专属业务实现**，位于 IM connector plane
之外，不在旧 census 任一类别中。凭据来自 `lark-cli`/`wecom-cli` 自身配置（本树内不可见）。

**裁定（reviewer ruling，2026-09-19）：不进 C1 inventory。** 它们是受保护的独立业务消费者
（enterprise workflow 旅程），**不因代码里出现"provider-specific"字样就自动被 C1 收编**——
§6.4 的判据针对的是 **IM connector 控制面**，不是任意平台业务实现。
Core C1 对它们只有一条义务：删除 IM / plugin 管理面时**不得波及**这两条业务路径及其回调路由。

### 2.4 concrete managed services — 旧清单 5 项存在，**另发现 2 项静默新增 + 1 项悬挂**

枚举源：`packages/api/src/domains/services/service-manifest.ts:178`（硬编码字面量数组，
是该 plane 的唯一 registry）。

| entry | 注册方式 | artifact 通道 | 备注 |
|---|---|---|---|
| `whisper-stt` | `SERVICE_MANIFESTS` | HuggingFace（5 个 MLX 模型）+ venv | — |
| `mlx-tts` | `SERVICE_MANIFESTS` | HuggingFace + **Piper `.onnx` 直链**（非 HF 通道）+ venv | 双 artifact 通道 |
| `embedding-model` | `SERVICE_MANIFESTS` | HuggingFace + venv | 唯一有 `onServiceReady` 回调特判（`index.ts:5968-6014`）；换模型会使 `evidence.sqlite` 向量失效 |
| `llm-postprocess` | `SERVICE_MANIFESTS` | HuggingFace（~20GB，最大） | 仅浏览器端消费，API 侧无消费者 |
| `audio-capture` ⚠ | `SERVICE_MANIFESTS` | **ModelScope**（第三个通道）+ Swift 采集二进制 | **悬挂**：安装/启动脚本硬依赖 `scripts/meeting-copilot/*`，该目录**不在本树中**。不是干净的 1:1 迁移对象 |
| **`collective-service`** ⚠ | **不在 registry**，`index.ts:5134-5141` 硬编码 | 无（纯 TS workspace 包） | 自有 `~/.cat-cafe/collective-service/`（含 `pairing`/bootstrap **secret**）、自有 health 契约、自有 `/api/plugins/collective-connector/service/provision` 路由 |
| **`personal-chrome-host`** ⚠ | **不在 registry**，`index.ts:5178-5188` 硬编码 | Chrome MV3 扩展 + 内容寻址 native host artifact | 与 §2.2 同一 entry；**还会写仓外**（OS 级 Chrome NativeMessagingHosts 目录 + Windows 注册表） |

两个静默新增都由 `packages/api/src/index.ts` 硬编码 wiring 注册而非任何 registry——
**这正是只查 registry 的 census 会漏掉它们的原因**。

**裁定（reviewer ruling，2026-09-19）**：5 个 managed services **明确归 C2**——本类依赖尚不存在的
typed hook / UI slot seam，而"新 seam 带第一个真实消费者一起开"正是 C2 的定义。
`audio-capture` 的悬挂状态**作为 C2 风险显式记录**，不在 C1 处置。
`collective-service` 记入 **supplemental census**（证明 census 方法学完备），
**但不是 §2.0 十一行 C1 migration entry 之一**。

Train C 完成线仍要求 inventory 100% disposition——C1 之后 Train C 未闭环是**预期状态**；
C1 PR 需把本类条目显式标为 `deferred → C2`，而不是不提。

`personal-chrome-host` 会写入仓库与 `.cat-cafe/` 之外的 OS 级位置（Chrome native messaging
manifest、Windows 注册表），其 uninstall 数据处置需单独审查，不能套用通用 plugin 策略。

### 2.5 INV-R2 守恒偏差汇总（共 4 项，**均已裁定**，见下表末列）

| # | 偏差 | 类型 | 为什么旧 census 会漏 | C1 disposition（已裁定） |
|---|---|---|---|---|
| 1 | `personal-chrome-host` | 新增 | manifest 根目录内但无 `plugin.yaml`，被 `PluginRegistry.scan()` 静默跳过 | 非 migration row；Host 安装/配对/Settings/receipt authority 受保护，删除面绕开（§2.2） |
| 2 | `collective-service` | 新增 | 不在 `SERVICE_MANIFESTS`，由 `index.ts` 硬编码 | supplemental census，非 C1 entry（§2.4） |
| 3 | `infrastructure/enterprise/` 的 Lark/WeCom action service | 新增 | 既非 IM connector plane 也非 plugin plane，不属旧清单任一类别 | 不进 C1 inventory；受保护业务消费者（§2.3） |
| 4 | `audio-capture` | 状态偏差 | 在清单内，但 runtime payload 已不在树中 → 无法按 1:1 迁移处置 | C2 风险记录（§2.4） |

**方法学教训**：以 `find -name plugin.yaml` 或"读 registry 数组"为准的 census 都会漏。
守恒检查必须以 `readdirSync(pluginsDir)` + 追 `index.ts` 硬编码 wiring 为准。

## 3. 三个 gate finding

### F-1（阻塞）：IM cutover 会静默移除 @-mention 唤醒

三源互证：

1. **代码**：`packages/api/src/domains/messaging/send-service.ts:154`
   `mentions: [], // v0: plugin sends never trigger @-routing (wake power is K-3a scope)`
2. **规格**：`docs/features/F288-plugin-messaging-domain.md:110`
   "v0 插件消息不解析/不触发 @ 路由（唤醒能力归 K-3a wake route）"
3. **roadmap**：§6.3 Phase 1 出口证据要求三入口共享"ledger、广播、**wake** 和 source 派生实现"

当前 `ConnectorRouter` 走 `parseMentions` → `mentions: CatId[]` → 唤醒；公共 SDK 路径恒为 `[]`。
因此把 7 个 IM provider 迁到公共 SDK 后，**在飞书/企微/Telegram 里 @ 猫将不再唤醒任何猫**——
这是主 IM 旅程上的用户可见功能回归。

**信任边界（修复必须落在这一层）**：mention 解析与唤醒是 **Host 权限**，绝不是插件文本权限。
F288 已冻结 v0 契约——插件以 `thread_handle` 用自己的声音说话时，**其文本永远不得产生唤醒**。
缺口在另一个 address kind：`connector_binding` 是 Host 验证过 `connectorId`/`externalChatId` 的
**已认证外部 ingress**（D-4，`send-service.ts:58-77`），对它 Host 必须像 `ConnectorRouter` 今天那样
自行派生目标并唤醒。所以正确的红灯是"**已认证 ingress 不唤醒**"，而不是"SDK `send()` 应当解析 `@`"。

**路线裁定（reviewer ruling，2026-09-19）**：F-1 的修复**并入唯一的 Core C1 聚合 PR**，作为
"切默认路径前"的内部 substage（即 §5 Stage 2a），**不另开 C1 PR**。依据 `docs/features/F202-plugin-framework.md:140`：
Core cutover "may add only the narrow migration/cutover wiring required to consume the
already-established Host plane"——本修复正是窄、业务无关的 migration wiring，整体大量删除后 PR
仍保持 deletion-dominant。

**硬止损线**：若实现需要新增 **public method / hook / UI slot**，立即停下转 C2，不在 C1 内扩公共面。
§6 的红灯把 seam 定在 `createMessagingDomain(...)`（F288 已命名的 K-2 装配点）——**这是一个被选择的
架构决定，不是"零绑定"**；但域内部落点刻意不约束（`SendService` / `MessageIngress` wrapper /
独立 admission service 均可），且不隐含任何面向插件的新 public API。

红灯证据见 §6。

### F-2（范围）：§6.3 Phase 1 的 canonical admission 尚未建立，Core PR 无法"以删除为主"

`ConnectorRouter.ts`（671 行）对 `domains/messaging` **零 import**，它自带：
duck-typed `messageStore.append()` 写入、`emitConnectorMessage` 自有广播、`InboundMessageDedup`
自有幂等、自有 thread 创建/绑定、自有 mention 解析。公共 SDK 侧则走
`SendService` → `MessagingLedger.claimSend/settleSend`。**两条写入路径今天不共享 admission。**

roadmap §6.3 把收敛拆成四阶段，C1 所述工作落在 Phase 3（迁移存量 connector）+ Phase 4
（删除第二业务路径）；Phase 1（建立 Host-owned canonical admission + 三入口 provenance + 差异测试）
与 Phase 2（至少一个真实外部化 IM slice 完成 ingress→thread→subscription→platform 往返）
是其前置条件，**均未完成**。

### F-3（治理）：Plugins roadmap 未记录 C1/C2 拆分

- Core 侧 `docs/features/F202-plugin-framework.md` §Train B/C Boundary 已权威定义 C1/C2。
- Plugins 侧 `docs/proposals/v0-implementation-roadmap.md` §5.3 仍写
  "GitHub、IM、voice/services 与其 UI contributions 全部进入 Train C **单一** Plugins 聚合 PR"，
  §6.4 完成线仍要求 inventory 100% disposition。
- INV-R4 规定该 roadmap 拥有跨仓执行顺序；两处真相不一致。

C1/C2 拆分本身有正当理由（C2 需要新建 typed hook/UI slot = §3.4 允许突破 PR 预算的"新信任边界"），
但必须落盘到 roadmap，否则 C1 的 Plugins 聚合 PR 在 review 时会与 INV-R2/INV-R4 直接冲突。

## 4. no-double-run / rollback / persistent-data 安全契约

### 4.1 迁移涉及的持久数据全集（code-derived）

| 载体 | key/路径 | 用户可见 |
|---|---|---|
| Redis | `connector-binding:<provider>:<externalChatId>`、`connector-binding-rev:<threadId>`、`connector-binding-user:<provider>:<userId>` | **是**（决定消息落到哪个 thread） |
| Redis | `connector-perm:<provider>`、`connector-perm-groups:<provider>` | **是**（授权） |
| Redis | `dingtalk-group-chat-ids`、`wecom-bot-group-chat-ids`（set） | 是 |
| Redis | `connectors:weixin:session-state`（长轮询游标 + context tokens） | 否，但丢失会导致消息重放/丢失 |
| Redis | `community:repo-comment:cursor:{repo}` | 否，同上 |
| 文件 | `.cat-cafe/im-connector-config/<id>.json` ×7（含 `_operations` 状态机） | 是（配置与登录态） |
| 文件 | `.cat-cafe/plugin-config/<id>.json` | 是 |
| 文件 | `.cat-cafe/capabilities.json` 的 `pluginId` ownership 记录 | 是 |
| 文件 | `.cat-cafe/plugin-host/personal-chrome-host/*.json` | 是 |
| thread 记录 | 内嵌 `ConnectorHubStateV1{connectorId, externalChatId}` | **是** |
| scheduler | `schedule:github:<name>` ×7 | 是 |

**契约 D1 — TTL=0**：以上标记"用户可见"的数据在迁移前后一律保持 TTL=0。迁移不得引入 TTL，
不得以"迁移期临时数据"为由缩短留存。

**契约 D2 — 只读镜像，不移动**：cutover 阶段对旧载体只做**读取与镜像**，不 move/不 delete。
旧数据的删除是 soak 之后单独审批的一步，不与默认路径切换同一 PR。

**契约 D3 — 幂等可重入**：每个 mapping 必须可重复执行且收敛到同一结果（参照 github 已有的
`.cat-cafe/f202-phase2-*-migrated` 标记文件模式，但标记文件本身不得成为唯一真相）。

### 4.2 no-double-run 强制点（INV-PM8 / INV-R3）

按 `connectorId` 建立 Host 级**排他 claim**：同一 provider 在任一时刻只能有
{legacy `ConnectorRouter` 路径, migrated plugin 路径} 之一处于 active。
该排他性必须由 Host 的 lease/fence 保证，**不能靠配置约定或启动顺序**。

验收：对每个 provider 跑「双路径同时配置 → 断言只有一条消费入站事件、只产生一条消息、
只唤醒一次」，并覆盖 restart 与 disable/re-enable。

### 4.3 已识别的具体迁移陷阱

1. **`isStaticConnectorId()` 会阻止迁移包认领自己的 id**。provider 身份今天重复存在于三处
   （per-provider `index.ts` 的 `definition`、`packages/shared/src/types/connector.ts` 的
   `CONNECTOR_DEFINITIONS`、`connector.yaml`），且共享列表被设为权威并**禁止外部插件复用这 7 个 id**。
   不先反转这条规则，迁移后的包根本装不上。
2. **4 个 env 变量不在 allowlist / reload keys 内**：`FEISHU_GROUP_BOT_MENTIONS_JSON`、
   `WEIXIN_VOICE_ITEM_MODE`、`WEIXIN_ENABLE_UNSAFE_VOICE_MODES`、`WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA`。
   只走 Hub UI 的配置迁移会**静默丢掉**它们，必须显式 mapping 或显式放弃并签字。
3. **新 Manager 今天反向依赖旧 registry**：`plugin-manager-compatibility.ts` 经
   `loadRepositoryPluginInfo`（`index.ts:4325-4333` 对 `pluginRegistry` 的闭包）读取 repository 行，
   且 `index.ts:5031-5033` 在其缺失时直接抛错。**旧 registry 不能先删**，必须先把 compatibility
   provider 换源。
4. **默认 Console 仍是旧面**：新 Manager 被 `?pluginManagerDemo=1` / `?pluginManagerLive=1` 门控
   （`plugin-manager-design-gate.ts`），`/settings?section=plugins` 默认仍渲染旧的 `PluginsContent.tsx`。
   "默认路径切换"在 Console 侧就是翻这个门控。
5. **`connector-gateway-bootstrap.ts` 含 4 处 provider 专属分支**（wecom-bot ×1、weixin ×3）
   外加 feishu 测试覆写分支，须随迁移一并拆掉。
6. **skill 挂载有跨项目级联副作用**（`PluginResourceActivator.ts:331-366`），`weixin-mp` 迁移时
   必须证明卸载能完整回收，不留悬挂 symlink。

## 5. 两仓串行计划

> **权威顺序（不可重排）**：Plugins 聚合迁移 → 精确发布 → **Core 业务无关 activation prerequisite**
> → 非默认路径消费证明 → Core cutover/删除。
> Plugins 侧不发布精确 package，Core 侧无从 pin，也无从证明迁移后的 provider 语义等价。
>
> **第二版修正（本文初版把 Core 的 wake 实现排在 Plugins 之前，方向反了）** 已在上一轮改掉。
>
> **第三版修正（2026-09-19 reviewer P1）——原 Stage 2 是不可达循环，必须拆开。** 上一版要求
> "Stage 2 走完 `use→restart` 才允许 Core 开始任何实现"。但 `use` 本身依赖两项**只有 Core 能提供**
> 的 Host 能力，二者在冻结基线上都不存在（证据见 §5.1）：外部 runtime 拿不到任何 provider
> config/secret，且没有生产路径为 package 签发 / 恢复 `connector_binding` handle。
> 于是「Stage 2 未完成 → Core 不得实现」与「Core 未实现 → Stage 2 无法完成」互锁。
>
> 解开的方式是**按依赖方向切开消费证明**：不依赖 Host 新能力的部分（安装/配置/启用/卸载）
> 留在 Stage 2 作为 Core 的进入条件；依赖 Host 新能力的部分（`use→restart` 往返）后移到 Stage 3，
> 在 Core 的业务无关 activation prerequisite（Stage 2a）之后、切默认路径之前完成。
> **Stage 2a 只做业务无关的 Host 能力，不含任何 provider 业务逻辑，也不切默认路径**——
> 因此它不违反"先发布再消费"的权威顺序。

### Stage 0 — 治理落盘（小，先做）

- 在 Plugins repo 的 `v0-implementation-roadmap.md` 记录 C1/C2 拆分、其 §3.4 突破预算的理由
  （C2 = 新 typed hook/UI slot 信任边界），并把 §6.4 inventory 更新为本文 §2 的 code-derived 结果，
  含 4 项偏差的已裁定 disposition。
- 解决 F-3。此步不含实现，必须先于 C1 Plugins PR 合入。

### Stage 1 — Plugins 聚合迁移 PR（PR 4/5）—— **由 Plugins owner thread 承载，不在本车道**

> 本节只记录 Core 侧的**依赖与验收接口**。实施由 thread `thread_mrkn6povq4zzgh45` 拥有；
> 本 worktree 不写 Plugins 业务代码。

- 一个聚合 PR 迁移 §2.0 冻结的 11 行（§2.1 全部 7 个 IM provider + §2.2 的 4 个 in-scope business plugin）。
- 每个包只依赖公共 SDK，不从 Core import 私有类型/store/registry/service instance。
- 每个包自带 config/state/secret/data mapping、rollback fixture 与真实 composition test。
- 至少一个 provider 先行完成 ingress→thread→subscription→platform 往返（§6.3 Phase 2 出口）。

### Stage 2 — 精确发布 + 不依赖 Host 新能力的消费证明（Core 的进入条件）

- Plugins 侧发布精确版本；Core 侧按 **exact version + digest** pin，不按 range、不按 dist-tag。
- 消费证明（**本阶段只到这里**）：至少一个已迁移 provider 在 Core 侧走完
  discover→install→configure→enable→disable→uninstall，**且不切换生产默认路径**。
  这一段只用既有 Host inventory/lifecycle 能力，今天就可达。
- **`use→restart` 往返不在本阶段**——它依赖 Stage 2a 的 Host 能力，放在这里即构成循环依赖。
- 本阶段未完成前，Core 侧不得开始 Stage 3 / Stage 4 的任何实现；**Stage 2a 例外且仅限业务无关能力**。

### Stage 2a — Core 业务无关 activation prerequisite（Core 聚合 PR 内最先执行）

> **Stage 2a 只做缺口 A/B/C**——它们都是**业务无关的 Host 能力**：不含任何 provider 业务逻辑、
> 不切默认路径、不删除任何东西。它们是 `use` 得以发生的前提，因此必须早于消费证明，而不是等待它。
> 缺口 D/E 不在 Stage 2a：其**新 ABI 设计线已停**（§7.3），迁移侧改用既有 Host 权威。

#### 5.1 五项缺口（冻结基线 `9ab0eaf28` 上 code-derived）

| # | 缺口 | 一手证据 | C1 分类 |
|---|---|---|---|
| A | ingress wake parity：已认证 `connector_binding` 不唤醒 | `send-service.ts:154` 恒 `mentions: []`；`MessagingDomainDeps`（`messaging-service.ts:21-26`）无 broadcast/wake/thread 协作者 | **C1 内**（§3 F-1 已裁定） |
| B | **生产 composition 不注入 Host 协作者** | `runtime-composition.ts:213` 以 `{messageStore, redis}` 组装 messaging domain | **C1 内**：窄 wiring，无公共面变更 |
| C | 外部 stdio runtime 收不到 config/secret | `external-runtime/supervisor.ts:191-201` 只传 `CLOWDER_PLUGIN_ID/PACKAGE_DIGEST/CONTRACT_VERSION/WIRE_VERSION` 四个协议变量 | **C1 内**：既有机制平移，见下 |
| D | **无法签发 / 恢复 `connector_binding` handle** | `issueConnectorBindingHandle`（`handles.ts:60`）**零生产调用者**（全仓仅 `messaging-service.ts:67` 转发 + 3 个测试）；contract 无任何 `connector.*` wire method | **新 public seam 不入 C1**：签发/恢复留在既有 Host 权威，迁移按冻结契约的 `ConnectorBindingAddress` 走（§7.3） |
| E | **connector 无持久 checkpoint**（provider cursor/sequence） | `plugin.state.get/set` 仅为**保留的 L0 能力名**，不在 13 行 wire registry 内，Core 无 handler / store / composition 路径；subscription cursor、inventory snapshot、7 天 TTL 的 messaging settlement ledger 均非替代 | **新 public seam 不入 C1**：重放由既有 `idempotencyKey` 幂等门挡（§6 用例 4），包侧 offset 属逐 provider parity 证据（§7.3） |

**C 为什么在 C1 内而不是 C2**：这套投影**已经存在**——`BuiltinPluginContributionSupervisor.contributionEnvironment`
（`manager/builtin-contribution-supervisor.ts:558-585`）已实现声明式 `{source: 'config'|'secret', key}`
绑定、`secret.read`/`plugin.config.read` 授权校验、必填缺失时 `CONFIG_UNAVAILABLE` fail-closed。
缺的只是把同一机制接到 stdio spawn 路径上，属于
`F202-plugin-framework.md:140` 的"消费既有 Host plane 的窄 migration wiring"，不新增任何公共面。

**D 的边界处置（第九轮范围纠正）**：contract 的 wire method 全集里没有 `connector.*`，
`M0CDeliverInput` 也只有 `{deliveryId, threadHandle, envelope}`——所以**在 C1 内设计一条
`connector.binding.*` 签发/恢复 wire 是越界的，这条设计线已停**（§7.3），不提案、不红灯、不等签字。
但"不开新 wire"**不等于**"迁移后移"：冻结契约里 `ConnectorBindingAddress`
（`@clowder-ai/plugin-contract` `dist/generated/contract.generated.d.ts:451`）**本身就是合法 send 地址**，
Host 侧 `HandleService.issueConnectorBindingHandle`（`handles.ts:60`）与 handle store 也已存在。
C1 的做法因此是**把签发/恢复留在既有 Host 权威侧**（§2.0「Core 保留的 Host truth」），
包只消费已签发的 binding 地址。两条禁令不变：不把签发权塞进不可信包代码，不让 package 自行合成 handle
（击穿 D-4）。**具体接线逐 provider 用 parity 证据验**（§5.3 connector 行删除门），Core 不在 C1 预判。

**E 的边界处置（第九轮范围纠正）**：Telegram long polling 与 WeCom Bot / XiaoYi 的 WebSocket resume 需要**重启安全**的 provider offset，否则重启后重复投递或漏投。
我曾一度判其为窄 wiring，理由是"wire 已声明 `plugin.state.get/set`"——**该判断错误，已撤回**：
这两个名字只存在于 capability 枚举与设计稿，**13 行 wire registry 里没有对应行**
（`dist/wire/registry.js:29-43` 的 `WIRE_METHOD_NAMES`），Core 侧也无任何实现。
（取证教训：当时把 `dist/wire/` 与 `dist/generated/` 合并 grep，命中来自能力枚举却被当成 wire row。）
**因此 C1 不声明 checkpoint wire / schema / grant——这条设计线同样已停**（§7.3）。
同样地，这**不推出**"IM 迁移整体后移"：重放在 Host 边界已有冻结契约内的防线——
`MessagingLedger` 的 `idempotencyKey` 幂等门（`ledger.ts:12`：claim TTL 60s、settled 保留 7 天），
其唤醒维度的可执行表达就是 §6 用例 4。**注意不要把它和 `InboundMessageDedup` 混为一谈**：
后者是**进程内** `Map`（`InboundMessageDedup.ts:6`），重启即失忆，不能算重启安全面。
包侧是否还需要额外 offset、怎么拿到，属于**逐 provider 的 package parity 证据**
（§5.3 connector 行删除门），由 Plugins 车道在 Stage 1/3 交付。
原先那套声明式 checkpoint 契约（per-contribution key + 实例命名空间 + TTL=0 + schema/大小限 +
CAS/operation-id 幂等 + settlement-ordered commit）的可执行红灯以 §6 case 12–21 存在，
**已移出 C1 门禁**；原文完整保留在 commit `7075c3aed`（取回方式见 §7.3），C2 立项时直接复用，不重写。

#### 5.2 Stage 2a 出口门

> **状态（本 branch 实测）：已满足。** 9 例全绿 0 错误；实现见 §6 转绿表（缺口 C/A/B 三提交，
> 外加第六轮 review 补的 settle-window 栅栏）。

- §6 的 **7 条 RED 全部转绿，且 2 条 GREEN guard 仍绿**（合计 9 例）。
- wake 必须 **source-derived**（Host 从已验证 provider identity + 已绑定 thread 推出），
  不接受插件自报 mention / 唤醒目标——否则等于把唤醒权交给外部进程。
- 无显式 mention 时必须复刻**三段式**路由：mention → 最近活跃参与者（`messageCount > 0`）
  → 默认猫。只接默认猫是用户可见回归（§6 用例 2/3）。
- seam 落在 `createMessagingDomain(...)` 这个 K-2 装配点，**且生产 composition 必须真正注入**（用例 7）。
- **不新增任何 public method / hook / UI slot**；一旦发现需要新增，停下转 C2——缺口 D/E 的
  **新 ABI 设计线**正是按这条停在 C1 之外（§7.3）；对应的**迁移本身仍在 C1**，走既有 Host 权威。
- 达成即 §6.3 Phase 1 出口条件。

### Stage 3 — 非默认路径消费证明（`use→restart` 往返）

- 在 Stage 2a 落地的 Host 能力之上，至少一个已迁移 provider 完成
  ingress→thread→subscription→platform 往返 + 重启后恢复绑定，**仍不切换生产默认路径**。
- 这是 §6.3 Phase 2 出口证据，也是允许进入 Stage 4 的唯一凭据。

### Stage 4 — Core cutover 与删除（以删除为主）

顺序严格：**先映射 → 再切默认 → 再证明不双跑 → 最后删除**。

1. 幂等迁移 §4.1 全部配置/binding/data（只读镜像，D2）。
2. 反转 `isStaticConnectorId()` 使迁移包可认领 7 个 id。
3. 切换默认路径（含 Console 门控翻转）。**Stage 2a 出口门 + Stage 3 往返证明未完成，本步不得开始。**
4. 提交 no-double-run 证明（§4.2 验收矩阵）+ rollback 演练证据。
5. 删除：provider-specific 实现、`im-connector-loader` 在进程内加载业务的路径、
   `ConnectorRouter` / `OutboundDeliveryHook` 业务路径、provider-specific
   `ScheduleFactoryRegistry` 实现、旧 `plugin-routes.ts` / `PluginsContent.tsx` /
   IM 管理面（`connector-hub.ts` 的 9 条 provider 路由、`connector-plugins.ts` 等第二安装入口），
   以及 `video-analysis` 的 repository-local duplicate（§2.0 baseline ledger）。
   删除前必须先完成陷阱 3 的 compatibility provider 换源，
   **且每一类删除都必须先过 §5.3 的贡献执行矩阵（新 owner 就位 + 旅程证明）**。
   **mcp 一类的取证顺序例外**（`video-gen` + `video-analysis` baseline）：Core 没有运行时替换
   机制——`replacesRepositoryPluginId` 只抑制 Manager 列表（§7.4.0 第 3 条）——所以 duplicate
   未删时旅程只能证明"两份并存"，证不了"外部包接住了"。该类的门因此读作**"新 owner 就位（包已
   发布且可安装）→ 删除 repo-local → 在删除后的树上取旅程证明"**，与 co-creator 裁定的两 PR 顺序
   一致（§7.4.1 第 9 行）。**此例外只对 mcp 一行成立**，不得套用到 connector / schedule / limb /
   skill / webhook——那五类今天连 owner 都不在位，先删就是净损失。
6. 保留：通用 Plugin Manager、connector binding、service lifecycle、scheduler、MCP runtime，
   以及 `plugin-access-guards.ts`。
7. **删除面显式排除项**（扫旧管理面时不得波及，依据 §2.2 / §2.3 / §2.4 裁定）：
   - `personal-chrome-host` 的安装 / 配对 / Settings 面板 / receipt authority 与
     `/api/plugins/personal-chrome*` 路由——它不是 `PluginManifest`，Host 继续拥有其语义。
   - `infrastructure/enterprise/` 的 Lark/WeCom action service 及其回调路由。
   - `feishu-meeting-intake` 的 Host wiring（既有 package，无删除面）。
   - `collective-service` 与 5 个 managed services 的现状 wiring（`deferred → C2`）。

#### 5.3 贡献执行矩阵 —— 删除的前置条件（每类都必须有新 owner）

> 上一版只说"删除 provider 实现与旧管理面"，没说**删完谁来执行这些贡献**。
> 11 行声明的贡献不止 MCP 一类；删掉旧执行 owner 而新 owner 不存在，
> 就是把飞书/微信扫码登录、企微回调校验、visible-reader arm 授权、GitHub 7 个 schedule
> 静默删成不可用。本矩阵是 Stage 4 第 5 步每一类删除的准入条件。

**冻结基线上外部包实际能拿到的执行面（code-derived，不是推测）**：

- Host broker 在生产组装里只注册**两族** method（`runtime-composition.ts:220-229`）：
  `events.publish` 与 `messaging.*`（`runtime-composition.ts:254-265`，合计 7 个方法）。
  **`schedule.register` 只是 `L1_CAPABILITIES` 的授权名，13 行 wire registry 里没有 `schedule.*` 行**——
  不是"有线没 handler"，而是没有线（§7.4.0 更正）。
- 贡献类型驱动的执行只有两处：`runtime-composition.ts:443-448`（capability 仅在 feature 的
  contribution 引用**全部**是 `mcp` 时才激活）与 `static-feature-authority.ts:267-269`
  （只接受 `content-editor-provider`）。
- 其余类型（`connector` / `webhook` / `schedule` / `limb` / `skill`）**今天只有 repository-local
  实现**：`plugin-manifest.ts:29` 的 `SUPPORTED_RESOURCE_TYPES` + `PluginResourceActivator`——
  **正是 C1 要删的那条路径**。

| 贡献类 | 需要它的行 | 今天的执行 owner（Stage 4 要删） | 外部包路径的新 owner | 专属旅程证明 | 删除门 |
|---|---|---|---|---|---|
| connector ingress/outbound | 7 个 IM provider | `im-connector-loader.ts:22-30` 进程内加载 + `ConnectorRouter` 自有写入/广播/唤醒 | **双边已指定**：Host 侧留既有 binding/config/state 权威（`HandleService.issueConnectorBindingHandle` + handle store + `HostPluginConfigurationService` + `MessagingLedger` 幂等门）；包侧由 Plugins 车道 11 行冻结包的 stdio runtime 承担 | 每 provider：ingress→thread→wake→outbound 往返 + 重启后绑定恢复 + **重启后不重复投递（replay/dedup）** | **per-provider package parity 证据** + §6 全绿 + Stage 3 往返证明（**不含任何 D/E 新 ABI 签字**） |
| provider 专属操作（QR/validate） | feishu QR ×3、weixin QR ×4、wecom-bot validate ×2 | `connector-hub.ts` 9 条 provider 路由 + `<id>.json` 的 `_operations` 状态机 | **不存在** | 扫码登录走通；企微回调校验通过 | 新 owner 就位 + 旅程绿 |
| webhook | wecom-agent（XML content-type 分支 `connector-webhooks.ts:51-66`）及通用回调 | `connector-webhooks.ts` 共享路由 | **不存在** | 回调签名校验 + 投递落 thread | 新 owner 就位 + 回调旅程绿 |
| schedule | `github` ×7 | `PluginResourceActivator` + provider-specific `ScheduleFactoryRegistry` | **不存在**：wire registry 无 `schedule.*` 行，host→plugin 也无通用 invoke 行（§7.4.0） | 7 个 schedule 各自触发 + 幂等（不双跑） | 新 owner + 触发证明 + §4.2 矩阵；**§7.4.2：该行在 C1 内阻塞于本门（不删、不补新公共面），是否改判 C2 待 operator 裁定** |
| limb | `weixin-mp`、`wechat-visible-reader` | `PluginResourceActivator.ts:170` | **不存在** | weixin-mp 发文；visible-reader arm 授权窗口仍受限 | 新 owner + 旅程绿 |
| skill | `weixin-mp` | `PluginResourceActivator.ts:331-366`（跨项目级联挂载） | **不存在** | 挂载 + **卸载完整回收**（陷阱 6，不留悬挂 symlink） | 新 owner + 回收证明 |
| mcp | `video-gen`（`video-analysis` 为 baseline） | `PluginResourceActivator` | ✅ `BuiltinPluginContributionSupervisor`（`runtime-composition.ts:462-490`）——**仅对 `runtime.transport === 'builtin'` 的包成立**（`:477`），stdio lane 不适用 | MCP tool 实际可调用，**且须在已删除 repo-local duplicate 的树上取证**（无运行时替换机制，未删时只证得出"两份并存"，§7.4.0 第 3 条） | 已有 owner，按现状过门（§7.4.2 判第 9 行留在 C1）；**取证顺序例外见 §5 Stage 4 第 5 步** |

**读法**：今天**直接通**的只有 mcp 一行。connector 一行的执行 owner **已经指定**——Host 侧保留既有
binding/config/state 权威（不新增公共面，§7.3），包侧由 Plugins 车道的 11 行冻结包承担——
但"已指定"不等于"已证明"：它的删除门仍然是**逐 provider 的 package parity 证据**，
拿不出证据的 provider 就不放行删除，而不是把整行挪出 C1。
其余五类（provider 专属操作 / webhook / schedule / limb / skill）今天既无外部包执行路径，
也还没有指派的新 owner。**任何一类在新 owner 就位并交出旅程证明之前，
对应的旧实现与旧路由都不得删除**——这比"删除面排除项"更强：排除项说的是"不要误删"，
本矩阵说的是"没接住就不准删"。

> **未决**：除 connector 与 mcp 外的五类，新 owner 归 C1 还是 C2 尚未裁定。若某类需要新的 typed
> hook / UI slot，按 §3 F-1 的硬止损线它属于 C2，届时该类的**迁移与删除一并后移**，
> 而不是删了之后留空。该裁定需要 Plugins owner thread 与 maintainer 共同确认（§7.2 第 4 条）。
> **connector 一行不在此列**：其 owner 已由既有 Host 权威 + Plugins 包 runtime 双边承担（§7.3），
> 待证明的是 parity 证据，不是 owner 归属。

### 组织约束

- 每仓独立 worktree；作者与 reviewer 不同个体。
- Core worktree 已建：`/Users/lang/workspace/github-lab/clowder-ai-f202-c1-core`，
  分支 `feat/f202-c1-core-cutover`，基于 `upstream/main` = 冻结基线。
- 涉及 Redis 的 restart/原子性测试一律使用隔离 store，不指向运行实例数据。

## 6. 红灯测试证据

红灯由**三个文件共同构成一道 9 例门**，断言点全部落在 **Host 信任边界**：已认证
`connector_binding` ingress 的唤醒契约与激活前提，而不是要求 SDK `send()` 改变插件消息语义。

| 文件 | 例 | 关注 |
|---|---|---|
| `packages/api/test/f202-c1-im-cutover-wake-parity.test.js` | 1–6、4b | **唤醒语义**：在 `createMessagingDomain(...)` 隔离注入协作者，精确钉住三段式路由与两条围栏 |
| `packages/api/test/f202-c1-production-composition-activation.test.js` | 7、10 | **生产可达性**：真实 `createDormantPluginRuntimeComposition(...)` 组装下的协作者注入与 config/secret 投影 |
| `packages/api/test/f202-c1-production-composition-helpers.js` | — | 共享 fixture（P2 抽取，避免文件重复组装并越过 350 行硬限） |

**红灯基线（`51d08596a`，实测）：6 红 2 绿**（8 例）；第六轮 review 后补入 **case 4b**（settle 失败窗口），门为 **9 例**。每条红灯均因其**声明的缺口**而红，非 fixture 错误——
1–4 停在 `send-service.ts:154` 的恒 `mentions: []`，7 停在 `runtime-composition.ts:213` 的协作者缺口，
10 停在 `supervisor.ts:191-201` 只投影四个协议变量；
且失败发生在 install → 挣得 config readiness → **写入 enabled 权威状态** → 认证握手**全部成功之后**。

**转绿现状（Stage 2a 已落地）：9 例全绿、0 错误**，两条 GREEN guard 仍绿。实现按缺口拆成三个提交
（顺序 C → A → B）：

| 缺口 | 提交 | 生产落点 |
|---|---|---|
| C | `da0508bbd` | `plugin/manifest-configuration-projection.ts`（新）+ `external-runtime/supervisor.ts` spawn env；composition 默认接 Host 自有 plugin-config store |
| A | `1cb65492c` | `messaging/ingress-wake.ts`（新）+ `send-service.ts` ingress 分支；`parseMentions` 与 catRegistry pattern 收敛为单一真相源 |
| B | `9b866e3f0` | `runtime-composition.ts` 转发协作者 + `index.ts` 注入真实 `invokeTrigger`/`threadStore`/`socketManager`/默认猫/mention patterns |

**第六轮 review 补入的一条（case 4b）**：case 4 只证"settle 成功后重放不重复唤醒"，那条由
settled-receipt 提前返回本身保证。真正威胁 at-most-once 的是另一个窗口——ingress 副作用已执行、
settle 失败、catch 释放 claim、重试重新进入。实测该窗口下 `messages=1, wakes=2, broadcasts=2`。
修法是给 ingress 副作用一条**独立的持久栅栏**（`ledger.ts` 的 `ingress` key space），
**先 settle 栅栏再执行副作用**：send claim 释放得掉，已上线的 broadcast 和已唤醒的猫释放不掉。
代价写明在 `send-service.ts` 注释里——栅栏与副作用之间崩溃会丢一次唤醒；重复唤醒会重跑一整轮
agent 并可能产生真实外部副作用，两者不对称，故取可恢复的那一侧。

复现（exact HEAD 本地运行）：

```
node --test packages/api/test/f202-c1-im-cutover-wake-parity.test.js \
             packages/api/test/f202-c1-production-composition-activation.test.js
```

**CI 承载 job（随 base 变动；本节自 `2e5a2769c` 合入 base `6291ff079` 起）**：#1483 把 public test 改成按资源域分片后，
v1 的 `Public test (serial)` lane 已不存在，`serial-shared` 的文件集为空（合并后 planner 实测 `serial_shared=0 distributable=2192`）。
这两个门文件落在 `runtime-isolated-default` 规则下的两条不同 distributable lane——
`f202-c1-im-cutover-wake-parity` → `distributable-2`，`f202-c1-production-composition-activation` → `distributable-3`
（下面那条附带边界用例 `plugin-external-runtime-config-projection` → `distributable-4`）。
因此"这道门在 CI 绿"**必须读多个 job**，不能再指向单一 serial job；原先"serial 因 fail-fast 只跑到第一个文件"的叙述同步作废。

**缺口 C 附带的信任边界**（`plugin-external-runtime-config-projection.test.js`，**不属于这 9 例门**）：
投影一旦存在，manifest 就能命名子进程环境变量，因此三条 fail-closed 规则各有可执行断言——
`CLOWDER_` 协议命名空间内的声明键拒绝启动（否则包可自称别的插件身份）、无对应 grant 的字段永不投影、
required 缺值拒绝启动。

**关于"激活"的措辞更正（第六轮 review P2）**：fixture 并不执行 lifecycle activation——
`lifecycle.enable()` 会拉起 stdio 进程并阻塞在这些用例自己要做的握手上，直接调用会死锁；
helper 最后一段 transaction 是**直接写入 enabled 权威状态**，随后由用例完成真实认证握手。
这不能被当作"激活成功"的证据。可被实现伪造的那一半（config readiness）仍经真实
`HostPluginConfigurationService` **挣得**，未手工翻转。

**fail-closed 边界的原子性不变量（第八轮 review P1，保留）**：`assert.rejects` 只证明"调用失败"，
不证明"没有落盘"——写完再抛的实现可以让负例转绿却已造成副作用。故本门保留的 fail-closed 边界
**同时**验证两件事：拒绝发生 **且** 无持久副作用。当前落地面是 forged-origin 用例 6——
增断言 `messageStore.messages.length === 0`；它此前只观测 wake/broadcast，标题里的
"before any persist"是一句**从未被观测的宣称**。

（checkpoint / binding 负例上的同款原子性断言随 D/E 的新 ABI 设计线一并移出 C1 门禁，见 §7.3。）

**为什么必须分两层**：只有 1–6 时，一个"永远不被生产组装调用"的实现即可全绿——
用例 1–4 的协作者是测试手工注入的。7 与 10 把同样的契约搬到**真实组装**上，
因此 1–6 定义"正确的唤醒长什么样"，7/10 保证"它真的发生在发布出去的进程里"。

| # | 用例 | 现状 | 语义 |
|---|---|---|---|
| 1 | 已认证 ingress 含 `@opus` → persist / broadcast / wake **各一次**，目标 = `opus` | 基线**红**（`mentions=[]`，0 broadcast，0 wake）→ 现**绿**（缺口 A） | C1 阻塞：`send-service.ts:154` 对所有 address kind 恒写 `mentions: []`，且 `MessagingDomainDeps` 根本没有 broadcast/wake/thread 协作者 |
| 2 | 无 mention **且 thread 有活动** → 唤醒**最近活跃参与者** | 基线**红** → 现**绿**（缺口 A） | `ConnectorRouter.ts:455-463`：先按 `messageCount > 0` 过滤，再按 `lastMessageAt` 取最新。用例里默认猫 `codex` 时间戳更新但从未发言，正确实现必须仍然路由到 `opus` |
| 3 | 无 mention **且 thread 无活动** → 才回退默认猫 | 基线**红** → 现**绿**（缺口 A） | 默认猫是**终点**而非唯一分支（`parseMentions(..., defaultCatId)`） |
| 4 | no-double-run：同 `idempotencyKey` 重放 → 回放同一 receipt 且**不第二次唤醒** | 基线**红** → 现**绿**（缺口 A：settled-replay 提前返回） | §4.2 防双跑契约在唤醒维度的可执行表达 |
| 5 | GREEN guard：`thread_handle` 插件自述文本含 `@opus`（且 thread 有活跃参与者） → 仍 `mentions=[]`、0 唤醒 | **绿（须保持）** | 围栏：修复不得以破坏 F288 v0 插件声音契约为代价 |
| 6 | GREEN guard：伪造 external origin → `PERMISSION`，0 persist / 0 broadcast / 0 wake | **绿（须保持）** | 围栏：ingress 权限来自 host-issued binding（D-4），不来自自报 origin |
| 7 | 生产组装下已认证 ingress → wake ×1 + broadcast ×1 | 基线**红**（观测 0 wake）→ 现**绿**（缺口 B） | 缺口 B：`runtime-composition.ts:213` 以 `{messageStore, redis}` 组装，协作者根本没有入口 |
| 10 | manifest 声明的 config/secret 投影进外部 stdio runtime，且**精确值**送达 | 基线**红**（实测 spawn env 仅 4 个 `CLOWDER_*`）→ 现**绿**（缺口 C） | 缺口 C：`supervisor.ts:191-201`；builtin 路径已有同款授权校验投影。**第四轮修正**：readiness 现由真实权威 `HostPluginConfigurationService.configure/reconcile` 挣得（不再手翻 `configReadiness`），并断言精确值而非仅 key，避免空值/占位转绿 |

**为什么 2 和 3 必须分开**：现网路由是**三段式**（mention → 最近活跃参与者 → 默认猫）。
只写一条"无 mention 就默认猫"的断言，会让一个只接默认猫的实现转绿，而真实回归——
在有活跃对话的群里 @ 之外的消息被路由给错的猫——照样发生。

**为什么两条 GREEN guard 是承重墙**：只让 1–4 转绿很容易（把 mention 解析塞进 `send()` 即可），
但那会同时踩碎 F288 与 D-4。**5/6 必须始终绿**，才证明唤醒权留在 Host 而没有漏给插件文本。

**这份测试绑定了什么、没绑定什么**（对 review 的显式交代）：
它驱动 `createMessagingDomain(...)`——F288 已把它命名为 K-2 Host Broker 的装配点——并在该处注入
Host 协作者，复用 `ConnectorRouter` 既有词汇（`invokeTrigger` / `socketManager` /
`threadStore.getParticipantsWithActivity`），不新造概念。
**把 seam 定在这个装配点是一个被选择的架构决定，不是"零绑定"**；而域内部的落点刻意不约束——
放进 `SendService`、包一层 `MessageIngress`、或单开 admission service，都同样满足这些断言。
对 **wake 用例 1–7 与 config 投影用例 10** 不隐含任何面向插件的新 public method / hook / UI slot。
这条限定现在**无例外**：原先仅有的两处例外（用例 8/9/11 的 binding bootstrap、用例 12–21 的
durable checkpoint）按定义各要求一条新的 public wire row，因此已随边界纠正移出 C1 门禁（§7.3）。
移出的是**这些新 ABI 的红灯**，不是 11 行的迁移与删除——后者仍在 C1，按 §5.3 的删除门逐行放行。

这道门是 **Stage 2a 的完成门**，也是 Stage 4 第 3 步允许切换默认 IM 路径的前置条件之一
（另一个是 Stage 3 的往返证明）。红灯本身不依赖任何 Plugins artifact，故先行提交；
转绿实现同样只动业务无关的 Host 能力，因此按 §5 line 336 的明确例外，**先于** Stage 2 的精确发布落地。
本门**不含任何待签字的公共面变更**：9 例全部落在冻结契约内的 Host wiring 上。

**Stage 2a 出口门已满足，但它不是 C1 的完成。** 仍未做、且不得跳过的是：Stage 2 精确发布与消费证明、
Stage 3 `use→restart` 往返、Stage 4 的 mapping / 切默认路径 / no-double-run 证明 / 逐 provider parity
证据后的删除。**切默认路径与删除仍未开始**，本阶段没有触碰任何 provider 业务逻辑，也没有删除任何东西。

## 7. disposition 状态

### 7.1 已裁定（2026-09-19 cross-cat review，本计划据此执行）

| 原开放项 | 裁定 | 依据 |
|---|---|---|
| `personal-chrome-host` 归属 | 非 C1 migration row，非 `PluginManifest`/installer；Host 保留安装/配对/Settings/receipt authority，删除面绕开 | roadmap §2.2 存量迁移行；`ownership/cells/plugin.md:131`（§2.2） |
| `infrastructure/enterprise/` Lark/WeCom | 不进 C1 inventory；受保护的独立业务消费者 | §6.4 判据针对 IM connector 控制面（§2.3） |
| `collective-service` / `audio-capture` | 前者记 supplemental census 非 C1 entry；后者作 C2 风险记录 | §2.4 |
| F-1 修复是否独立 PR | **并入唯一 Core C1 聚合 PR**，作切默认路径前的内部 substage（§5 Stage 2a） | `F202-plugin-framework.md:140` 窄 migration wiring 条款（§3 F-1） |
| 5 个 managed services | `deferred → C2`；Train C 在 C1 后未闭环是预期状态 | §2.4 |

### 7.2 仍需 maintainer 签字（本计划不自决）

1. **F-3 治理**：Plugins roadmap §5.3/§6.4 仍写"Train C 单一聚合 PR"，与 Core F202 的 C1/C2 拆分
   冲突（INV-R4 规定该 roadmap 拥有跨仓执行顺序）。需 maintainer 批准把拆分落盘到 roadmap。
2. **陷阱 2 的 4 个 env 变量**：显式 mapping 还是显式放弃——放弃需签字，不能静默丢。
3. **旧持久数据的最终删除**（契约 D2 的第二步）：soak 之后单独审批，不与默认路径切换同 PR。
4. **§5.3 五类贡献的新执行 owner 归属**：provider 专属操作 / webhook / schedule / limb / skill
   今天都没有外部包执行路径。逐类裁定归 C1 还是 C2；凡判 C2 者，其**迁移与删除一并后移**，
   不得先删后补。**connector 与 mcp 不在此条**：前者由既有 Host 权威 + Plugins 包 runtime 双边承担
   （§7.3），后者已有 owner；两者的放行条件是 parity/旅程证据，不是签字。

### 7.3 C1 ↔ C2 边界纠正（2026-09-20，已裁定：**C1 不新增 D/E public wire；迁移与删除仍在 C1**）

**裁定**：§7.2 原第 4 条（缺口 D，`connector.binding` 签发/恢复）与原第 5 条（缺口 E，声明式持久
checkpoint）曾被写成「并入 C1 公共面」vs「整体后移 C2」的二选一——**这个二分本身是错的**。
真正成立的只有一件事：**C1 不新增任何 public wire row / hook / UI slot**，所以这两条的
**新 ABI 设计线停止**：不提案、不红灯、也不等 maintainer 签字。
**§2.0 的 11 行 migration set，其迁移与删除仍然在 C1**，用冻结契约 + 既有 Host 机制做，
按 §5.3 的删除门逐行放行。

**依据（均为一手核验，非转述）**：

| 来源 | 内容 |
|---|---|
| co-creator `0001789821850712-001832-35062316` | 主仓 thread「主要是删代码」，新增代码走平行的 Plugins 仓 |
| co-creator 第九轮范围纠正 | 契约已完成，不在 C1 重开；**Plugins 补齐包与 runtime，Core 做映射、切默认、防双跑与删除**；删除只在 package parity 证据之后 |
| Plugins 结论 `0001789822832664-001868-63e5a564` | 既有 `ConnectorBindingAddress` **已足以表达正确路径**，无需新增 public seam；「Core 只负责 Host 前置与删除式切换，不越界实现插件业务代码」 |
| 冻结契约（一手） | `ConnectorBindingAddress` 是合法 send 地址（`dist/generated/contract.generated.d.ts:451`）；13 行 wire registry（`dist/wire/registry.js:29-43`）里无 `connector.*` / `plugin.state.*` |
| 本计划 §5.2 自身条款 | C1 不新增 public method / hook / UI slot |

**纠正的边界在哪里（第九轮，已撤回上一版的过头推导）**：上一版把「停止扩契约」推成了
「§2.0 第 1–7 行（7 个 IM connector）在 C1 内没有可交付的删除面，随 D/E 一并进 C2」。
**该推导过头，已撤回。** 证据只支持「不新增 D/E 公共面」，不支持「迁移整体延期」。现行裁定：

1. **7 个 IM connector 仍在 C1 的 cutover/delete 范围内**。顺序不变（§5 Stage 4）：
   映射 → 切默认 → 防双跑证明 → 删除；删除门见 §5.3——**per-provider package parity 证据**，
   证据不到位就不放行该 provider 的删除，而不是把整行挪去 C2。
2. **既有 Host-owned binding / config / state 权威由 Core 用现有机制继续保管**（§2.0「Host truth」）：
   `HandleService.issueConnectorBindingHandle`（`handles.ts:60`）+ handle store、
   `HostPluginConfigurationService`、`MessagingLedger` 的 `idempotencyKey` 幂等门
   （`ledger.ts:12`：claim TTL 60s、settled 保留 7 天）。**Core 不为它们新开公共面。**
3. **Core 不实现 Plugins 业务代码**：stdio entrypoint、catalog/包闭合、fresh-consumer 证据
   由 Plugins owner thread 在既有契约下直接完成；Core 不代写、也不等它的 schema 裁定。
4. **Host 前置（缺口 A/B/C）不变**，仍是现在这道 9 例门；用例 10 的 config/secret 投影
   正是 Plugins 侧 stdio entrypoint 需要的那一半。
5. **逐行核验已完成，见 §7.4**：§2.0 第 8–11 行（`github-operations` / `video-generation` /
   `wechat-visible-reader` / `weixin-mp`）各自落在 §5.3 哪一类贡献、新 owner 是否就位。
   结论：**只有第 9 行（`video-generation`）今天在 C1 内可交付**；第 8 / 10 / 11 行都需要新公共面。
   **这是阻塞证据，不是改判授权（第六轮 review P1）**：三行仍在 §2.0 的 11 行冻结集内，在 C1 内
   的处置是**卡在 §5.3 删除门上**——不删、不提新公共面、迁移不完成。是否改判 C2 是 operator 裁定，
   本 PR 不做（当时的 Decision Packet 见 §7.4.5；**终局结论已由 §8.3 取代**：三行在 C1 内由通用载体无关边界承接）。

**移出 C1 门禁的只有测试面（不重写、不丢失）**：

| 移出面 | 用例 | 原文位置（均 @ `7075c3aed`） |
|---|---|---|
| 缺口 D — binding 签发 / 重启恢复 / 跨 connector 否定例 | 8、9、11 | `packages/api/test/f202-c1-connector-binding-durability.test.js` |
| 缺口 E — checkpoint 持久性 / settlement 顺序 / 幂等 / 实例隔离 | 12、16、18、20 | `packages/api/test/f202-c1-connector-checkpoint-durability.test.js` |
| 缺口 E — 声明式 key / schema-size / unsettled ref / 内容禁令 / 缺 grant | 13、14、15、17、19、21 | `packages/api/test/f202-c1-connector-checkpoint-safety.test.js` |
| 缺口 E 专用 fixture（含 commit 计数与专属 grant 推导） | — | `packages/api/test/f202-c1-checkpoint-fixture.js` |

这 13 例经 4 轮跨猫 review 收敛（`f444e91c3..7075c3aed`），C2 立项时直接 `git show` 取回。
**它们描述的是尚未存在的公共面，不是 11 行迁移的前置条件**——把两者绑在一起正是上一版的错误。

**作者自述偏差（不掩饰，两次同源）**：

- **第一次（第 5–8 轮）**：我已一手查实 `ConnectorContribution` 是封闭类型
  （`additionalProperties:false`）、13 行 wire registry 无 `connector.*` 行——证据指向
  「声明通道今天不存在 ⇒ 属 C2」，我却读成「所以要在 C1 里设计这条通道」，
  并连续硬化这个**未签字**的公共面，违反本计划自己写下的「签字前不动工」。
- **第二次（第九轮）**：纠正方向对，但**纠正过头**——把「不扩契约」推成「7 个 IM 行整体后移 C2」，
  用一个范围错误替换了另一个范围错误。

两次共同根因：**我用自己的推导替代了对一手裁定的回读**——第一次没回读 §5.2 自己写的限制，
第二次没回读 co-creator 原话与 Plugins 的「`ConnectorBindingAddress` 已足够」结论。
跨猫 review 能验门内部自洽，**验不出坐标系选错**；这两次都由外部裁定纠回，不是我自查出来的。
结构性后果写进流程：**凡改动 C1/C2 边界，必须在同一次提交里引用一手裁定原文，并同步 §5.3 的删除门**，
不得只改结论段。

### 7.4 §2.0 第 8–11 行逐行核验（§7.3 第 5 条指定的下一工作项）

> 执行于 `6c793db6`（Stage 2a 落地后）。全部**重新 code-derive**，不照抄 §5.3 的既有结论；
> 与 §5.3 冲突处以本节为准，更正在 §7.4.3 列出。契约坐标均为 api 实际解析到的
> `@clowder-ai/plugin-contract@0.1.0-beta.15`。

#### 7.4.0 先决事实 —— Core 今天只消费两类 external contribution

契约侧 `StaticContribution` 是 12 类联合（`contract.generated.d.ts:267`），`schedule` / `skill` /
`limb` 各有正式类型（`:141` / `:171` / `:176`）——外部包**声明得出来**。但 Core 侧对这些类型的
消费只有两处：

| 消费点 | 接受的类型 | 坐标 |
|---|---|---|
| capability 激活 | feature 的 contribution **非空且全部**是 `mcp`，且包的 `runtime.transport === 'builtin'` | `runtime-composition.ts:477-486` |
| static feature authority | 仅 `content-editor-provider` | `official-package-installer.ts:312-314` |

`PhysicalLimbContribution` / `PhysicalLimbGrant` / `L1_CAPABILITIES` 在 `packages/api/src` 内
**零引用**（grep @ HEAD）。结论：外部包声明的 `schedule` / `skill` / `limb` / `webhook`
**在 Core 今天是惰性的**——既不报错，也不执行。

**两条被 §5.3 说弱了的事实：**

1. **`schedule.register` 不是 wire，是 grant 名。** 13 行 wire registry
   （`dist/wire/registry.js:29-42`）里没有任何 `schedule.*` 行；`schedule.register` 只出现在
   `L1_CAPABILITIES`（`contract.generated.js:8`）。即不是"有线没 handler"，而是**没有线**——
   包拿到该授权也无方法可调。且 `ScheduleContribution.action` 是 `CallbackAction{method}`
   （`:130`/`:151`），而 host→plugin 方向只有 `host.messaging.deliver` / `host.grants.changed` /
   `host.lifecycle.ping` / `host.lifecycle.drain` 四行，**没有通用 invoke 行**，Host 无从触发
   包内的 schedule action。
2. **mcp 这条"已有 owner"只覆盖 builtin transport lane。** `activeBuiltinCapabilities` 在
   `packageRecord.manifest.runtime.transport !== 'builtin'` 时直接返回空
   （`runtime-composition.ts:477`）。契约把 runtime 分成 `ExternalRuntimeDeclaration`
   （`stdio` / `ipc`，`:276-279`）与 `BuiltinRuntimeDeclaration`（`builtin`，`:280-283`）两支。
   所以第 9 行要走通这条 owner，**包必须发成 `transport: 'builtin'`**，与 7 个 IM connector 走的
   stdio + broker wire 是两条不同的 lane，不能互相引证。
3. **`replacesRepositoryPluginId` 只抑制 Plugin Manager 列表，不做运行时替换。**
   `resolveRepositoryReplacementPluginIds`（`machine-catalog-provider.ts:136-147`）在 `src` 内的
   **唯一**消费点是 `loadSuppressedPluginIds`（`index.ts:5056-5066`），而它的唯一消费点是
   `plugin-manager-compatibility.ts:93-96` 的 `.filter((plugin) => !suppressed.has(plugin.id))`
   ——即只把 repo-local 条目从 Manager 列表里隐藏。repo-local MCP toolset 的**运行时**注册走的是
   另一条路：`capabilities.json` 的 capability 条目 → `acp-mcp-resolver.ts:283`
   （`type === 'mcp' && !disabled && !retired`），**完全不读 suppression**。Core 今天唯一的
   运行时"退役 capability"机制是 `isRetiredGithubMcpCapability`
   （`retired-github-mcp.ts:67-72`），判据硬编码 `capability.pluginId?.toLowerCase() === 'github'`,
   **GitHub 专用，不可复用为通用替换**。

#### 7.4.1 逐行结果

| # | 行 | 声明（一手，`packages/api/src/plugins/<id>/plugin.yaml`） | §5.3 类 | 新 owner 就位？ |
|---|---|---|---|---|
| 8 | `github-operations` ← `github` | 7 × `schedule`（`factoryId: github.*`，其中 3 个 `optional`） | schedule | ❌ |
| 9 | `video-generation` ← `video-gen` | 1 × `mcp`（`video-gen-toolset`） | mcp | ✅（限 builtin lane） |
| 10 | `wechat-visible-reader` | 1 × `limb` | limb | ❌ |
| 11 | `weixin-mp` | 1 × `limb` + 1 × `skill` + `healthCheck.limbCommand` | limb + skill | ❌ |

**第 8 行 `github-operations` — 阻塞点两条。** 除 §7.4.0 的"无触发线"外，Host 的排程注册表是
**用户可见面**：7 个 schedule 以 `scheduleTaskId: schedule:github:<name>`
（`github-schedule-factories.ts:548`）进入 `taskRunnerV2`，激活判据硬编码
`c.type === 'schedule' && c.pluginId === 'github'`（`:656`、`:441`），rehydrate 入口在
`index.ts:4509-4517`。外部包既无线注册进来，Core 的判据也认不出它。把实现删掉而包接不住，
等于把 7 个排程静默删成不可用。

**第 9 行 `video-generation` — 唯一今天可交付的一行。** cutover 用的是 Core **已有且已投产**的
机制：`pluginManagerHostPolicies`（`index.ts:5027-5032`）今天恰好只有一条
`{ pluginId: 'dev.clowder.video-analysis', replacesRepositoryPluginId: 'video-analysis', … }`，
经 `resolveRepositoryReplacementPluginIds`（`machine-catalog-provider.ts:143-144`）把 repo-local
条目从 Plugin Manager 列表里抑制掉。第 9 行照此加一行即可，**不新增任何 public method / hook /
UI slot**，符合 §5.2。

**但这条机制只覆盖列表视图，不覆盖运行时（§7.4.0 第 3 条）**，因此第 9 行的删除顺序不是可选的：
在 repo-local `video-gen` 的 `plugin.yaml` 与 capability 条目仍在时，旧 toolset 照常注册，与外部包
的 toolset **并存**；suppression 只是让用户在 Manager 里看不见旧的那份。所以**删除是 parity 的
前置条件，不是收尾动作**——不先删就无从证明"外部包接住了"，只能证明"两份都在"。这与 co-creator
裁定的两 PR 顺序（core 删代码 → 插件仓补实现发包 → core 在删除后的代码上做安装/卸载与功能验收）
同向，且为其提供代码级依据：该顺序不是流程偏好，是因为 Core 没有运行时替换机制。

**baseline `video-analysis` 今天正处在这个中间态**（本节执行时一手核实）：host policy 已投产，
而 `packages/api/src/plugins/video-analysis/` 连同其 `plugin.yaml`（`resources: [{type: mcp,
name: video-analysis-toolset}]`）**完整存在**。§2.0 把它记为"策略已在位"是把列表抑制读成了
运行时切换——更正见 §7.4.3 第 6 条。

**第 10 行 `wechat-visible-reader` — 三处硬编码 Host 分支 keyed on repo-local id**
（全部在 `index.ts`）：

- `isWeChatVisibleReaderEnabled`（`:4520-4528`）：以 `capability.type === 'limb' &&
  capability.pluginId === 'wechat-visible-reader' && capability.enabled` 为 arm 路由的启用判据；
- `registerWeChatVisibleReaderArmRoutes`（`:4530-4534`）：Host 自有的 arm 路由 + armStore + metrics；
- `beforePluginDisable`（`:4540-4542`）：停用插件时 `disarm()`，外部包路径没有对应钩子。

迁移后该 capability 记录不再出现在 `capabilities.json` → `isPluginEnabled` 返回 false →
arm 路由**静默 fail-closed**；`beforePluginDisable` 的 disarm 语义直接丢失。

**第 11 行 `weixin-mp` — 三重阻塞。** (a) limb 与 skill 两类都无 owner；(b) 即便有，它是
**混合类型 feature**，`runtime-composition.ts:485` 要求 `every(type === 'mcp')`，**永不激活**；
(c) `healthCheck.limbCommand` 在**契约里根本不存在**——`PluginManifest`（`:284-296`）无
`healthCheck` 字段，该字段只存在于 Core 的 repo-local schema（`plugin-manifest.ts:323-329`）。

#### 7.4.2 C1 处置

| # | 处置 | 依据 |
|---|---|---|
| 8 | **留在 C1，阻塞于 §5.3 删除门**：不删 `github-schedule-factories.ts`、不提新 wire，迁移不完成；改判 C2 待 operator | 需新增 schedule 触发线（新 public wire）→ §3 F-1 硬止损线 + §7.2 第 4 条"判 C2 者迁移与删除一并后移，不得先删后补" |
| 9 | **留在 C1 并交付**：加 host policy 一行 + 删 repo-local duplicate（**删除在前，验收在删除后的树上**）；门 = 包以 `transport: 'builtin'` 发布 + 在已删除 repo-local 实现的 Core 上证明 MCP tool 实际可调用 | 走既有 `replacesRepositoryPluginId` 机制，无新公共面；但该机制只抑制 Manager 列表、不做运行时替换（§7.4.0 第 3 条），故 duplicate 未删时 parity 不可证 |
| 10 | **留在 C1，阻塞于 §5.3 删除门**（同上）；改判 C2 待 operator。**arm/disarm 隐私授权权威在任一结局下都按 `personal-chrome-host` 同例保留为 Host truth**，不随该行的处置改变 | 需 limb 宿主消费面（新公共面）；三处 Host 分支见 §7.4.1 |
| 11 | **留在 C1，阻塞于 §5.3 删除门**（同上）；改判 C2 待 operator | 需 limb + skill 两类宿主消费面、混合类型 feature 激活规则、`healthCheck` manifest 字段——三者都是新公共面 |

**对 Stage 4 第 5 步删除面的直接后果**：`github-schedule-factories.ts`、`weixin-mp` 的 limb/skill
挂载、`wechat-visible-reader` 的 limb 与上述三处 Host 分支，**在 C1 内均不得删除**；只有
`video-gen` 的 repo-local 实现可删——且按 §7.4.1 第 9 行，**删除必须先于 parity 验收**，不是"证明
parity 之后再删"。这与 `video-analysis` baseline 的删除面（§2.0）形状相同，可同批执行；两者今天
都**尚未删除**，所以是同一批待收尾面，而不是"照着一个已完成的先例做"。

#### 7.4.3 对 §5.3 / §7.2 / §2.0 的更正与影响

1. **更正 §5.3 schedule 行**："contract 有 `schedule.register` wire，但 Core 未注册 handler"
   → 应为"**wire registry 无 `schedule.*` 行**；`schedule.register` 仅是 `L1_CAPABILITIES`
   授权名，且 host→plugin 无通用 invoke 行"。
2. **精确化 §5.3 mcp 行**：`BuiltinPluginContributionSupervisor` 这条 owner **只对
   `runtime.transport === 'builtin'` 的包成立**，对 stdio external runtime 不成立。
3. **§7.2 第 4 条的五类里，本节给出三类的 code-derived 归属建议：schedule / limb / skill → C2**
   （连同其迁移一并后移）。仍需 maintainer 签字确认。**webhook 与 provider 专属操作两类不在本节
   范围**——它们属第 1–7 行，本节只核 8–11。
4. **不改变 §7.3 对第 1–7 行的裁定**：connector 行走既有 Host 权威 + messaging/events wire，
   与本节四行的阻塞原因不同源，两边的结论不可互相套用。
5. **C1 第 8–11 行今天的可交付面只有一行**（第 9 行），另外三行卡在 §5.3 删除门上。
   **这两句话不等于"C1 只剩一行"**（第六轮 review P1 纠正）：「没接住就不准删」是 C1 **门内**的
   结果，管的是"今天不删"；把行移出 11 行冻结集是**改 operator 冻结的迁移集**，是另一件事，本节
   此前把前者当成了后者的依据。11 行仍然全在 C1；三行的状态是"迁移未完成、阻塞待裁"，
   处置选项与代价见 §7.4.5，**终局结论以 §8.3 为准**。
6. **更正 §2.0 baseline ledger 与 §2.2 的 `video-analysis` 行**（本节执行时发现，方向与第 5 条
   相反——这两处不是把 C1 说小了，是把第 9 行的既有机制说强了）。两处原写
   "`index.ts:5011` 的 `replacesRepositoryPluginId` 策略已在位"，暗示运行时切换已就绪、Core 只差
   删文件。一手事实是：该策略**只抑制 Plugin Manager 列表**，运行时 toolset 仍由
   `capabilities.json` 驱动（§7.4.0 第 3 条），且 `video-analysis` 的 repo-local 实现今天
   **完整存在**。故更正为"策略已在位（仅列表抑制）；运行时 duplicate 未删，parity 未证"，
   并同步坐标 `index.ts:5011` → `index.ts:5027-5032`（冻结基线后已漂移）。
   **对删除门的影响**：§5.3 "没接住就不准删"在第 9 行这一类上不能反推成"证明接住了再删"——
   Core 无运行时替换机制时，不删就无从证明接住，只能证明两份并存。故第 9 行的门读作
   **"删除在前，在删除后的树上验收 parity"**（§7.4.2）。

#### 7.4.4 取证深度教训（本节第 6 条是**自查**所得，不是外部退回）

§7.3 的偏差记录结尾写着"这两次都由外部裁定纠回，不是我自查出来的"。本节第 6 条是第三次更正，
性质与前两次都不同，记下来以免后来者误以为所有更正都得靠外部。

| | 前两次（§7.3） | 本次（§7.4.3 第 6 条） |
|---|---|---|
| 错在哪 | **范围**判断：C1/C2 边界 | **机制强度**判断：既有机制能到哪 |
| 方向 | 过度扩张 → 过度后移（把 C1 说小了） | 把既有机制说强了（把 C1 说容易了） |
| 纠回路径 | 外部裁定 | 自查（追消费链） |

**共同根因仍是同一个，只是换了表面**：前两次是"用自己的推导替代回读一手裁定"，本次是
**停在"机制存在"而没追到"消费链终点"**——两者都是**取证深度不足**。我看到
`pluginManagerHostPolicies` 里确有 `replacesRepositoryPluginId: 'video-analysis'`，就据此写下
"已有且已投产的机制"；实际要追三跳才见底：`resolveRepositoryReplacementPluginIds`
→ 唯一消费点 `loadSuppressedPluginIds`（`index.ts:5056-5066`）
→ 唯一消费点 `plugin-manager-compatibility.ts:93-96` 的列表 `.filter()`。第三跳才暴露它**只管
列表不管运行时**。

**流程沉淀（与 §7.3 末尾那条并列，同样适用于本计划的后续修改）**：
凡在计划中写下"走既有机制 / 已有 owner / 策略已在位"，**必须把该机制的消费链追到终点消费者
并记录坐标**，不得只记机制的定义点或注册点。判据是可证伪的一句话：
**"这个机制被谁读？读了之后改变了什么可观察行为？"**——答不上来就不算"已有 owner"。
本节对 `video-analysis` baseline 的重新核实（repo-local 目录与 `plugin.yaml` 今天完整存在）
就是这条判据的直接产物。

#### 7.4.5 ~~待 operator 裁定~~：第 8 / 10 / 11 行的 C1 结局（**已由 §8.3 取代，本节仅存推导记录**）

> **读者先看 §8**：本节的"三选一"与"按选项 2 落盘"已被 2026-09-20 的 operator anchor
> （`…-002857-30d55ba2` / `…-002875-f1e0d445`）取代——这三行改为由 §8 条款 2 的通用
> 载体无关 lifecycle / action 边界在 C1 内承接。下文保留是为了记录推导与越权更正的过程。

**为什么是 operator 的题**：§2.0 的 11 行 migration set 是 operator 冻结的。本节核出的
「三行今天无法在 C1 内完成迁移」是**阻塞证据**；把行移出冻结集是**改冻结契约**。第六轮 review
（sol）判定本计划此前用前者当后者的依据，属越权改范围——此处收回，改为呈给 operator。

**冲突的两条硬约束**（都不是本计划能放弃的）：

| 约束 | 出处 | 内容 |
|---|---|---|
| A | §2.0（operator 冻结） | 11 行都在 C1 迁移 |
| B | §3 F-1 + §7.3 裁定 | C1 不新增任何 public wire / hook / UI slot |

第 8 / 10 / 11 行要完成迁移**必须**新增公共面（第 8 行：schedule 触发线；第 10 行：limb 宿主消费面；
第 11 行：limb + skill 两类消费面 + 混合 feature 激活规则 + `healthCheck` 字段）。A 与 B 在这三行上
不可同时满足——**这是一个取舍，不是一个技术选型**。

**三个结局，各自的代价**：

| 选项 | 内容 | 代价 |
|---|---|---|
| 1 | 为这三行**放宽 B**：允许 C1 新增所需公共面 | C1 从"主要是删代码"变成"扩 ABI"；新公共面需 maintainer 签字，C1 周期显著变长；F-1 止损线失效 |
| 2 | **守 B，C1 带伤落地**：三行留在 C1 但迁移不完成、repo-local 实现不删 | 11 行冻结集在 C1 结束时只完成 8 行；Core 里三份 repo-local 实现继续存在，删除面推到 C2 |
| 3 | **正式改判 C2**：operator 把这三行移出 C1 冻结集 | 冻结集被改小；需 operator 明确认可这不是猫自决的范围缩水 |

**后到的 operator anchor 已表述了选项 1 的原则（本节写定之后）**：本节落盘于 `899b38753`；其后
operator 在 `0001789885252322-002807-a0cec6ac` 给出理解——「这个 PR 我理解不就是简单的迁移；然后
如果 SDK 能力不足**可能要补接口而已**，这是我理解可能唯一阻塞的」，sol 在
`0001789885253811-002813-c1474cd9` 把它操作化为「缺什么通用 contract/SDK 接口就在这份聚合 PR
补齐……不增加第三个 PR」。按 §7.4.0 的一手结论，第 8 / 10 / 11 行与 connector egress 是**同一种
形状**：契约里声明得出来（`contract.generated.d.ts:141` / `:171` / `:176`），Core 侧没有可执行线
（`schedule.register` 是 grant 名不是 wire；host→plugin 只有 4 行、无通用 invoke）。所以
**选项 1 不再是"需要新授权才能选"的选项——它就是 operator 已经表述过的原则**，上表"代价"一列里
"F-1 止损线失效"应读作"operator 已接受为迁移的正常代价"，而不是本计划要替他承担的风险。

**据此收窄后，真正留给 operator 的只剩一问，而且是量级不是选项**：同一条原则在 connector 上
花掉的是**一个窄方法**（`host.connector.deliver`）；在这三行上要花掉的是**三类宿主消费面 + 混合
feature 激活规则 + 一个 `healthCheck` manifest 字段**（§7.4.2）。原则不变，量级差一个数量级。
**问：这个量级是否仍在"补接口而已"之内？** 是 → 本节按选项 1 改写，三行所需公共面进 #54 / #1487，
不另开 PR、不再等裁定；否 → 请 operator 明说边界落在哪一行（退回选项 2 或 3）。

> 本节**不代 operator 作答**。缩小 §2.0 冻结集在任何情况下都不是猫的权限（第六轮 review 已判过
> 一次越权，见本节开头），本次同样不动冻结集、不改本 PR 落盘形状。这里只做两件事：把后到的
> 一手 anchor 接进来，以及把题从"三选一"收窄成"量级是否仍在原则内"。

**本 PR 当前按选项 2 的形状落盘**（不删、不提新公共面、状态记为"阻塞待裁"），因为它是三者中
**唯一不需要新授权就能停在原地**的，且对另外两个选项都不造成不可逆损失。operator 选 1 或 3 时，
本节按裁定改写即可。

**不随选择改变的一条**：第 10 行 `wechat-visible-reader` 的 arm/disarm 隐私授权权威，在三个选项
下都按 `personal-chrome-host` 同例**保留为 Host truth**，不下放给包。

---

## 8. C1 Terminal Acceptance Contract（2026-09-20 冻结）

> **本节的地位**：这是两仓 C1 的**共同终局契约**在 Core 侧的写定。它由 operator 的
> pause-and-align gate 要求产生（`0001789886680827-002881-10e236ef`，经 sol relay
> `0001789886789246-002888-19d5ba70`）：两条车道先把共同终点写进各自 PR 内的持久验收文档，
> 互读对方 exact HEAD，回传实质确认，齐了才解除实现暂停。
> **本节优先于本文件第 1–7 节中与之冲突的任何表述**，也优先于此前所有聊天更正。

### 8.0 权威 anchor（一手，全部 operator 原话）

| anchor | 内容（要点） |
|---|---|
| `0001789885765960-002823-862c7258` | 我们是**客户端应用**（Eclipse 热加载 / VSCode / IDEA 插件机制的同类）；插件提供**完整 runtime 的 package 包**供 host 加载调用；插件仓是官方来源之一，**本地自行安装不应被拦截**，用户自担风险；**"不是一个插件就来一个子进程"** |
| `0001789886247327-002857-30d55ba2` | 模型应当简单清晰：host 提供稳定 runtime + 接口；插件按 SDK + yaml 契约补完实现；**插件可以是独立子进程也可以是一个 package 包，对 host 不关心**；host 只按**生命周期与 action** 操作；`start` 可能什么都不干、也可能拉起子进程，**这应在 yaml / SDK 中声明**；只要插件**启动加载失败不影响主 host** 即可；插件实现有错误是允许的，**禁用 / 卸载即可恢复** |
| `0001789886563068-002875-f1e0d445` | **C1 这边也一样**：把现有能力收敛成**载体无关的统一生命周期**，本来就该做完；所以这次 **host 侧应在清理旧代码时一次性补齐** |
| `0001789886427425-002863-501608eb` | 插件仓已有一批存量插件，其 SDK / yaml 是否 ok 要一并核，不 ok 就在迁移时补齐；这一轮两个 PR 合入后插件仓阶段性收尾，下一轮才是涉及前端的 C2 |

### 8.1 七条冻结条款

| # | 条款 | Core 侧可验收判据 |
|---|---|---|
| 1 | **package 是分发单位；runtime carrier 是 manifest 声明的实现细节** | Core 不得把 carrier 当作分类依据向 Manager / catalog / domain 泄漏；carrier 只在 adapter 内部可见 |
| 2 | **Host 只暴露一条载体中立的 lifecycle / action 边界** | `start / stop / reload / action` 对所有已安装 instance 走同一条路径；carrier adapter 由 manifest 选出，不由调用方选 |
| 3 | **#54 收口全插件仓 SDK / YAML / package 兼容性** | Plugins 车道交付物，是 Core 的**输入**；Core 只消费 exact artifact，不代改包 |
| 4 | **#1487 在同一 PR 内原子完成 Host lifecycle 收口 + 旧执行路径删除** | 收口与删除不得拆成两个 PR，也不得只改计划不落生产代码 |
| 5 | **Plugins exact artifact → Core 集成旅程 → 依赖序合并** | Core 钉 exact 版本 / digest；#54 先于 #1487 合入 |
| 6 | **disable / uninstall 可恢复、启动失败隔离、重启恢复、Core 内无 package-specific 分支** | 四条各需可观察证据；Core 代码内不得出现任何具体 pluginId 的分支 |
| 7 | **C2 才做前端 contribution 扩展；C1 不留 lifecycle / 删除 follow-up PR** | C1 结束时不得有"下轮再收口 / 下轮再删"的尾巴 |

### 8.2 今天的差距（code-derived at `a275987`；生产代码自 `91d9ad9` 起未变，两个标签指同一棵树）

**违反条款 2（载体分流仍在 domain 层）**：

| 坐标 | 事实 |
|---|---|
| `runtime-composition.ts:136-197` | `PluginRuntimeSupervisorRouter` 按 `manifest.runtime.transport === 'builtin'` 分流到两套 supervisor |
| `runtime-composition.ts:162` / `:179` / `:478` | 同一 transport 判据出现在 start / stop / capability 投影三处 |
| `builtin-runtime/hybrid-supervisor.ts:49` / `:93` / `:131` | supervisor 内部再次按 transport 分叉 |
| `content-editor-runtime/admission.ts:10`、`manager/builtin-contribution-supervisor.ts:292`、`manager/local-package-admission.ts:234`、`official-package-installer.ts:307` / `:368` | 准入 / 安装路径同样以 transport 为分类依据 |

**违反条款 6（Core 内存在 package-specific 分支）**：

| 坐标 | 事实 |
|---|---|
| `runtime-composition.ts:322` | `new Set(collectiveConnectorRuntime ? ['official.collective-connector'] : [])` —— 硬编码具体 pluginId 进 Core 组装 |
| `runtime-composition.ts:152` | 路由判据 = 该 id 集合 ∪ `staticEditorContributions(manifest)`，即"身份 + 贡献形状"，不是统一生命周期 |

**违反条款 1 + 2（`builtin` 在两仓是两个不同的东西 → #54 合入后 install+enable 在 Core 上启动即红）**：

这一条不是推导，是两侧一手代码对读出来的。Plugins 在 `3ae7ad2` 用 `builtin` 表示 **Host 进程内
加载的包模块**；Core 今天的 `builtin` 是"**每个 MCP contribution 一个子进程**"。两个声明值同名
不同义，而且 Core 对非 MCP contribution 是**抛错**而不是降级：

| 侧 | 坐标（exact HEAD） | 事实 |
|---|---|---|
| Plugins `3ae7ad2` | `packages/connector-telegram/plugin.yaml` | `runtime.transport: builtin` + `entrypoint: dist/plugin-entrypoint.js`；feature `telegram-messaging` 只引用 `identity` + `connector` 两类 contribution，**一个 MCP 都没有** |
| Plugins `3ae7ad2` | `packages/connector-telegram/src/plugin-entrypoint.ts:71`（dingtalk 同形 `:66`） | `export default createTelegramPluginModule()` —— 默认导出一个 `PluginModuleEntrypoint` |
| Core `a275987` | `runtime-composition.ts:162-167` / `:179-184` | `transport === 'builtin'` 且不属 `baseOwnsBuiltin`（`:151`）→ 路由到 `BuiltinPluginContributionSupervisor` |
| Core `a275987` | `manager/builtin-contribution-supervisor.ts:218-241` | `requestedContributions()` 对**任何非 MCP contribution 直接抛 `UNSUPPORTED_CONTRIBUTION`**（`:232`），MCP 非 stdio 也抛（`:238`） |
| Core `a275987` | `manager/builtin-contribution-supervisor.ts:517-534` | `launchSpec()` 只会 `command: process.execPath, args: [entrypoint, …]`，即**子进程**载体 |

结论：**Core 里一行 in-process 模块载体都不存在**——两个 transport 取值都是进程载体。这正是
operator `…-002823-862c7258`"不是一个插件就来一个子进程"指着的位置，也说明条款 1 的"carrier 是
manifest 声明的实现细节"今天在 Core 上并不成立。按条款 3 + 4，这是 **#1487 的活**（Core 补齐
载体中立 adapter，形状见 §8.6），**不是退回 Plugins 改包**。

**已在位、可直接复用的地基（不推翻）**：`PluginRuntimeLifecyclePort`
（`external-plugin-lifecycle-types.ts:43`）、`HybridPluginRuntimeSupervisor`、
`start-authority.ts` 的 instance / grant revision fence、`ingress-wake.ts` 的 broadcast / wake
双 fence、`manifest-configuration-projection.ts` 的 fail-closed 三规则。**这批地基与载体无关，
在新模型下全部保留**——它们约束的是**权威**（谁能读 secret、谁能唤醒、谁能删），不是**载体**。

### 8.3 §7.4.5 的重新定位（第 8 / 10 / 11 行不再是"待裁定三选一"）

§7.4.5 把这三行的结局呈为"放宽 B / 带伤落地 / 改判 C2"三选一，并按选项 2 落盘。**该三选一已被
§8.0 的后到 anchor 取代**：`…-002875-f1e0d445` 明确要求 host 侧在本轮清理旧代码时**一次性补齐
载体无关的统一生命周期**，条款 7 又禁止留 follow-up。两者合起来的结论是唯一的——

> 第 8 / 10 / 11 行所缺的"宿主消费面"，不再是**为这三行新增的专用 wire**（那才需要放宽 B），
> 而是**条款 2 那条本来就要建的通用 lifecycle / action / contribution 边界**的自然消费者。
> 它们在 C1 内完成，不推 C2，不留 follow-up。

§7.4.5 中"本 PR 当前按选项 2 的形状落盘"一句**到此失效**；该节保留为推导记录，结论以本节为准。

**曾留给对侧精确退回的残留（已闭合）**：条款 7 的"前端 contribution 扩展 = C2"是否覆盖
limb / skill 两类宿主消费面（第 10 / 11 行）。本计划的判断是**不覆盖**——limb 与 skill 是 agent 侧
消费面，不是前端 slot / 面板，而 operator 在 `…-002863-501608eb` 里把 C2 描述为"涉及前端的"。

Plugins 车道在 `3ae7ad2` 采纳了同一判断，且不是只改了 prose，而是**同时改到可执行账本**：
`docs/plans/2026-09-19-train-c1-plugins-aggregate-migration.md` 条款 7 的括号收窄为"deferred
audio/managed-service surfaces and the retained StackChan physical-hardware limb product"并显式
排除 `wechat-visible-reader` / `weixin-mp` 的 agent 侧 limb/skill 消费；`migration/f202-train-c1-inventory.json`
新增 `c1AgentContributionConsumers` 两行；`scripts/train-c1-inventory.test.mjs:73-77` 把它写成断言。
**本残留到此关闭，不再是解除暂停的前置条件。**

### 8.4 作废项

- **`host.connector.deliver` 窄行作废**：该提案已由 Plugins 车道撤回（对应 worktree 已 revert、
  未 push）。Core **不实现、不评审**该行 / 其 grant / 其 state 形状。
- 受此影响，§7.4.5 末段以"connector 上只花掉一个窄方法"为基准做的**量级对比失效**；该比较所服务的
  三选一本身已由 §8.3 取代。

### 8.5 暂停与解除条件

本 PR 自 `91d9ad9` 起**暂停新增生产实现**（§8 各节均为 docs-only 对齐提交）。解除条件是且仅是：
两条车道的实质确认齐全 + owner thread `thread_mrkmxgdfqquounc9` 明确解除暂停。

齐备情况（截至本次提交）：

- Plugins 侧确认：**已到位**——`3ae7ad2`，owner thread `0001789887656811-002946-931f06b4`，裁定
  `aligned—no disagreement`。
- Core 侧确认：**本次提交即是**——§8.7 记录互读 exact HEAD 与裁定；§8.2 的 C-1 与 §8.6 的
  adapter 目标形状把原先只存在于聊天里的执行缺口写成了验收项。
- 仍差的只有一项：owner thread 明确解除暂停。**不再等对侧回答接口形状**——§8.6 已由 SDK 源码
  推导出来，不需要猜；唯一残留（导出名写进契约）不阻塞实现。

解除后 #1487 的下一步是**按条款 2 / 6 收口 Host 生命周期 + §8.6 的 adapter**，而不是继续在旧分流
上补丁。

**暂停已于 2026-09-20 解除**：owner thread `…-002967` 正式解除两仓暂停，`…-002980` 确认两条实现线
继续；Core `f20cc2d` 的裁定为 `aligned—no disagreement`。实现自本节之后恢复，推进顺序见 §8.8。


### 8.6 载体中立 adapter 的目标形状（code-derived at Plugins `3ae7ad2`，不是猜的）

§8.2 的 C-1 要求 Core 补齐"模块载体"。它的目标形状**不需要等对侧口头确认**——Plugins SDK 在
`packages/plugin-sdk/src/feature-context.ts` 已经把它写死了，Core 照着实现即可。以下坐标全部
在 Plugins exact HEAD `3ae7ad2`：

| 步 | 一手坐标 | Core adapter 必须做的事 |
|---|---|---|
| 1 | `:387-389` `PluginModuleEntrypoint { create(manifest: unknown): DefinedPlugin }`；`:392-396` `definePluginModule` 返回冻结对象 | 从 `runtime.entrypoint` 指向的模块取**默认导出**，断言其有 `create` |
| 2 | `:465-480` `definePlugin` —— 包侧自校验并冻结 manifest | Core 把**自己认定的 manifest 真相**传进 `create()`，不接受包自报的那份 |
| 3 | `:428-461` `activateDefinedFeature(plugin, featureId, context)` → `ActivePluginFeature { actions, dispose }`（`:382-385`） | 按 Host 授权**逐 feature** 激活；未声明 / 缺失的 action handler 由 SDK 抛 `TypeError` 并自动 dispose，Core 不必重复校验 |
| 4 | `:109-135` `FeatureContext` | Core 提供 `config` / `secrets` / `state` / 各 contribution registrar / `connectors.deliver` / `logger`；**secret 读取权威仍在 Host**（§8.2 已落的 fail-closed 配置投影原样复用） |
| 5 | `:458` `disposePromise ??= …` | **dispose 幂等已由 SDK 保证**，Core 不需要自建去重；但必须在 stop / disable / uninstall / 启动失败回滚四条路径上都真的调到它（条款 6 的可观察证据） |

action 方法名的**合法集合**由 manifest 推导（`:398-412` `actionMethods`）：connector → `outboundMethod`；
schedule / tool / webhook / message-subscription → `action.method`；service → `healthMethod`；
ui command → `action.method`。Core 的 action 路由按同一推导做，**不得**按 pluginId 或 contribution
形状另建分支（条款 6）。

**`builtin` 取值的处置**：Core 把 `builtin` 收敛为"**Host 进程内模块载体**"这一个语义，MCP 降回
**一种 contribution 类型**（由 adapter 内部按需拉子进程），不再是一个载体取值。这样条款 1
（carrier 只在 adapter 内可见）与 operator"不是一个插件就来一个子进程"同时成立。

**需对侧钉死的一点**（~~不阻塞~~ —— 本段的"不阻塞"判断已被 **§8.8** 修正：开工后核实际制品发现
`PluginModuleEntrypoint` 等符号根本未发布，该请求已与发布序依赖合并，见 §8.8）：模块导出名目前是**约定**——
telegram `plugin-entrypoint.ts:71`、dingtalk `:66` 都是 `export default`，但 SDK 类型和
`plugin.yaml` schema 里都没写这条。请 Plugins 车道把"`runtime.entrypoint` 的默认导出必须是
`PluginModuleEntrypoint`"写进 SDK 契约或 manifest schema；否则第三方包可以合法地导出别的名字，
而 Host 无从发现。Core 先按默认导出实现，对侧钉死后若取值不同再改 adapter 一处。

### 8.7 互读记录（exact HEAD，两条车道各一次）

| 项 | 值 |
|---|---|
| Core exact HEAD | `a2759879e3f64b357c8ba90c3cf486f8b607c07f`（#1487 draft，docs-only） |
| Core 契约位置 | 本文件 §8 |
| Plugins exact HEAD（本次读的） | `3ae7ad2006ec3f2d7688bd145d8092bf3d89eabb`（#54 draft） |
| Plugins 契约位置 | `docs/plans/2026-09-19-train-c1-plugins-aggregate-migration.md` + `migration/f202-train-c1-inventory.json` + `scripts/train-c1-inventory.test.mjs` |
| 契约裁定 | **aligned — no disagreement**（七条条款逐条对读一致；§8.3 残留已由对侧在同一 HEAD 闭合） |
| 非契约分歧 | 无。§8.2 的 C-1 是**实现缺口**，按条款 3 + 4 落在 #1487 自己的验收范围内，不是两份契约之间的分歧 |

对侧的对应记录：Plugins 在 `migration/f202-train-c1-inventory.json` 的 `scopeAuthority.coreCounterpartRead`
里把 Core HEAD 钉为 `a2759879e…`，并由 `scripts/train-c1-inventory.test.mjs:232-236` 断言。两侧互钉完成。

### 8.8 §8.6 的发布序依赖（2026-09-20 实现开工首日 code-derived，**升级为阻塞项**）

§8.6 把"唯一仍需对侧钉死的一点"记为**导出名约定**，并判定其**不阻塞**。开工后按条款 5
（"Core 钉 exact 版本 / digest"）去核实际要消费的 artifact，发现一条**比它更硬的**事实：
§8.6 的目标形状所依赖的 SDK 符号**在任何已发布制品里都不存在**。

**一手证据**（全部可复算）：

| 项 | 观测 | 取证方式 |
|---|---|---|
| Core 当前钉的版本 | `@clowder-ai/plugin-sdk` `0.1.0-beta.10`、`@clowder-ai/plugin-contract` `0.1.0-beta.15` | `packages/api/package.json:62-63` |
| npm 上最新已发布 | sdk `0.1.0-beta.11`、contract `0.1.0-beta.16` | `npm view @clowder-ai/plugin-sdk versions` |
| beta.11 的 feature-context 公共面 | `createFeatureContextSession` / `definePlugin` / `FeatureHostAdapter` / `FeatureContext` / `DefinedPlugin` / `FeatureActivator` / `FeatureBinding` / `ContributionRegistrar` …（14 个） | `npm pack @clowder-ai/plugin-sdk@0.1.0-beta.11` 后读 `package/dist/index.d.ts:20` |
| beta.11 **没有**的符号 | `PluginModuleEntrypoint`、`definePluginModule`、`activateDefinedFeature`、`ActivePluginFeature` | 同上，导出清单里逐名核对，beta.10 同样没有 |
| `FeatureActivator` 在已发布 SDK 的形状 | `(context: FeatureContext) => void \| Promise<void>` —— **返回 void，没有 actions** | beta.10 `dist/feature-context.d.ts` |
| Core 今天对 SDK 的消费面 | **只有一个文件**：`external-runtime/stdio-broker-transport.ts:26`；feature-context 一行未用 | `grep -rn '@clowder-ai/plugin-sdk' packages/api/src` |

即：§8.6 表格里的坐标（`:387-389` / `:392-396` / `:428-461`）是 Plugins **源码** `3ae7ad2` 的坐标，
不是 Core 能 `import` 的制品坐标。

**影响按步拆开（不是整体阻塞）**：

| §8.6 步 | 内容 | 今天能不能做 | 依据 |
|---|---|---|---|
| 1 | 取 `runtime.entrypoint` 默认导出、断言其有 `create` | **能** —— 结构化鸭子类型，不需要 SDK 导出该 type（§8.6 已授权"先按默认导出实现"） | 本节 |
| 2 | Host 把**自己认定的 manifest 真相**传进 `create()` | **能** —— 纯 Core 侧 | 本节 |
| 4 | Host 提供 `FeatureContext`（config/secrets/state/registrar） | **能** —— `createFeatureContextSession(binding, adapter)` 与 `FeatureHostAdapter` 已发布 | beta.10/11 `dist/feature-context.d.ts` |
| 5 | dispose 幂等 | **能** —— 已发布 SDK 以 `FeatureContextSession.revoke` 提供，且 `revokePromise` 已做记忆化 | beta.10 `dist/feature-context.js:182-190` |
| 3 | `activateDefinedFeature` → `ActivePluginFeature { actions, dispose }` | **不能** —— 符号未发布；`FeatureActivator` 返回 void，运行时不存在 actions 对象 | 本节 |

结论：**条款 2 的 lifecycle 半边（start / stop / reload）不被此依赖阻塞**，Core 可以照常收口；
**action 半边被阻塞**，因为"载体中立的 action 路由"需要 SDK 侧的逐 feature 激活返回 action 表。

**对 Plugins 车道的精确请求（属条款 3 + 5，不是新 follow-up）**：#54 在收口 SDK 时需发布一个
导出 `PluginModuleEntrypoint` / `definePluginModule` / `activateDefinedFeature` /
`ActivePluginFeature` 的版本（即把 `3ae7ad2` 的源码形状带进制品），Core 随后按条款 5 钉该 exact
版本。§8.6 原来那条"导出名写进契约"的请求**并入本项一起交付**——两者都是同一个发布的内容。
这不违反条款 7：条款 5 本就规定 #54 先于 #1487 合入，Core 消费对侧本轮发布物是**既定依赖序**，
不是留到下一轮的尾巴。

**Core 在此期间的推进顺序**（据上表，不等待）：先做不依赖该发布的部分——载体中立的**权威**与
**生命周期**收口、条款 6 的 package-specific 分支清除、旧执行路径删除；action 路由在对侧发布落地后
接上。首个落地切片见下。

**已落地（本次提交）**：配置授权改为载体中立——`resolveManifestConfiguration` 成为唯一裁决点并
保留每个字段的 `kind`（模块载体要把 secret 送进 `FeatureContext.secrets`、把 string/select 送进
`config`，这是两个命名空间）；`projectManifestConfigurationEnv` 降为"该裁决的 env 投递"，stdio
载体行为逐字节不变（`test/f202-c1-carrier-neutral-configuration.test.js` 的 parity 例钉死）。
三条 fail-closed 规则一条没改；规则 1（`CLOWDER_` 协议命名空间）**保持 manifest 级拒绝**而不是
env 级，否则同一个包会因载体不同而准入不同——那本身就是条款 1 的泄漏。
