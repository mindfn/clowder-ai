---
feature_ids: [F190]
related_features: [F056, F041, F099, F145, F102]
topics: [console, settings, layout, navigation, design-system, services, install, sidecar, lifecycle]
doc_kind: spec
created: 2026-05-07
---

# F190: Console Settings Shell — 全局导航 + 设置面板骨架

> **Status**: Implemented (branch), pending merge | **Owner**: Ragdoll | **Priority**: P0

## Why

team experience:
> "我们的 Hub 承载了太多东西——成员配置、MCP 管理、IM 连接器、信号、记忆全塞在一个模态弹窗里。模态层叠越来越深，每次都要从 Hub 入口钻进去。"

F099 把 Hub 从 3 个 tab 扩到 8 个，但本质问题没变：一个 modal 不该是应用的主导航。需要一个正式的 shell 布局——ActivityBar 全局导航 + Settings 面板替代 Hub modal + 统一设计体系。

## What (PR #662)

- **AppShell**: ActivityBar rail（导航、置顶区、主题切换）+ ThreadSidebar + 内容区三栏布局
- **Settings skeleton**: SettingsShell + SettingsNav 侧边栏，`?s=` 参数路由 12 个 section，占位符内容
- **CSS tokens**: `console-shell.css`、`theme-tokens.css`，语义色变量（`--cafe-*`、`--console-*`、`--semantic-*`）+ 字体 token
- **Tailwind utilities**: `text-caption`、`text-label`、`text-compact`
- **Hook**: `usePinnedSections` 持久化 localStorage 置顶设置区

## Acceptance Criteria

- [x] AC-1: AppShell 三栏布局渲染（ActivityBar + ThreadSidebar + content）
- [x] AC-2: Settings 12 section 通过 `?s=` 路由可达（占位符内容）
- [x] AC-3: CI 全绿（Build/Lint/Test）
- [x] AC-4: 浏览器验证（theme toggle / pinned persistence / ActivityBar referrer）
- [x] AC-5: 合入 main 后视觉回归验证（#662 / #669 已合入 main，无回归）
- [x] AC-6: Sub-scope Service Manifest — Linux ARM64 完整 install + autostart + console disable/enable verify pass (PR #674)
- [ ] AC-7: Sub-scope Service Manifest — Windows x86 / Mac arm64 verify pass (PR #674, 进行中)
- [ ] AC-8: PR #674 upstream maintainer review + merge

## Merge Plan (Three-PR Path)

| PR | 内容 | 状态 |
|----|------|------|
| #662 | F190 AppShell / Settings 骨架 | ✅ merged to main |
| #669 | F190 完整功能迁移（Settings 内容、MCP、marketplace、Mission Hub 等） | ✅ merged to main |
| #674 | F190 followup: 跨平台 install / sidecar lifecycle / embedding consistency | 🟡 branch, codex review pass, Linux verified, Windows/Mac pending |

#645 保留为开发基线/参考。

## Dependencies

- F056: 设计 token 契约（被本 feature 迁移和扩展）
- F041: Capability Dashboard（被 Settings 面板整合）
- F099: Hub Navigation Scalability（被 Settings shell 替代）
- F145: MCP Portable Provisioning（MCP 管理面板基于此）
- F102: Memory Adapter Refactor（PR #674 修了 embedding catch-up 链路）

## Risk

- **Dual ThreadSidebar**: AppShell 和 ChatContainer 各有一个 ThreadSidebar，过渡期共存。后续 cleanup PR 跟进移除。
- **Planned API endpoints**: 部分 Settings 面板引用尚未实现的后端路由，前端已就绪，后端跟进。

## Sub-scope: Service Manifest (ML 服务统一管理)

ML sidecar 服务（ASR/TTS/Embedding/LLM-postprocess）从 `start-dev.sh` 硬编码迁移到声明式 manifest + API 驱动管理。

### Done (PR #645 / #662 / #669)

ServiceManifest 类型 / ServiceConfig 持久化 / service-registry 运行时 / API 路由 (GET/POST /api/services) / ServiceStatusPanel UI / autostart / 启停脚本迁移到 `scripts/services/`

### Done (PR #674 — followup) — 30+ commits 按主题分组

**1. 跨平台 install bootstrap**
- `bf6bdb19` / `78319d9c` Windows ARM64 Python detection via PE header arch（替代 `platform.machine()`，后者在 Prism emulator 下假报 ARM64）
- `16fbc356` `Try-*` PowerShell 函数移除 `Add-Member -PassThru`（implicit pipeline output → caller 收 array of 2 同 obj）
- `827901ab` `_try_uv` / `_try_pyenv` / `_try_brew` 也跑 `_python_version_ok` ensurepip 校验
- `093d40b4` install / uninstall 加 sentinel log，silent skip 暴露可见
- `eaa4403a` + `32ef1ad7` `sqlite-vec ^0.1.6 → ^0.1.9`（0.1.6 上游漏发 `linux-arm64` prebuilt）

**2. 单源真相：模型选型治理**
- `14c153e5` 删 `EmbedConfig.embedModel` union 类型 + `VALID_EMBED_MODELS` 白名单；默认 `'unknown'` sentinel，由 sidecar `/health` probe 接管真模型 id
- `d76a1659` 11 处 install 脚本 fallback model 改 fail-fast（缺 env → 中文错误 + `exit 1`）
- `b14c34c5` / `83aa04c7` x64 默认推 BGE-small-zh；jina 模型 `attn_implementation` runtime override 'eager'
- `b29c04d0` 所有 server scripts 模型默认从 hardcoded 改 env-driven
- `658b8c92` 抽 `resolveSelectedModel` 到 `service-model-resolver.ts` —— autostart / `/start` / install endpoint 共享同一优先链

**3. 代理 / 镜像 fallback**
- `f3a86c0d` PowerShell `Sync-SystemProxy` probe 用 `HttpClient + UseDefaultCredentials=$false`，强制 anonymous 探测（不让 .NET 自动 NTLM auth 误判 corp proxy 可用）
- `658b8c92` `python-resolve.ps1::Sync-ResolverSystemProxy` 加 sibling `Test-ResolverProxyAnonymous`，跟 `prereq-check.ps1` 一致，不再 bypass anonymous probe
- `9e998c4f` 代理 guidance 改"方案 A 配代理（带 auth 标准 URL）/ 方案 B 配镜像源"通用文案

**4. Embedding catch-up 链路**
- `b7da7863` `'started'` event hook 主动 `await embedding?.load()` 重新 probe `/health`，拿 sidecar 真实 `modelId`
- `d1ce4fa8` `/api/services/:id/start` + install endpoint auto-start branch 都 fire `'started'`（之前只 autostart fire）
- `e551dc36` catch-up hook 注册带 `{ unregisterOnSuccess: false }`，让 disable→enable / 重启 sidecar 多次 `'started'` 触发都能跑
- `09eba460` 新 helper `watchForRunningAndFire` 替代 `waitUntilHealthSettles`：5s × 60 polling, **只接受 `'running'` 终态**（不让 ECONNREFUSED 误判为终态 `'stopped'`）
- `95a0b192` **Push-based ready signal**: spawn `stdio: 'pipe'`，新 helper `wireUpSidecarReadyListener` parse stdout 的 `__CATCAFE_SIDECAR_READY__` marker（embed/whisper/tts 各加 fastapi `@app.on_event("startup")` hook）。llm-postprocess 后台异步 load 不发 marker，polling 兜底
- `658b8c92` `IndexBuilder.embedPending` 入口先 `checkMetaConsistency`，model/dim 变化 → `clearAll` → 后续 SELECT-NOT-IN 自然报全部 docs 为 pending → re-embed all（修静默错搜索结果 bug）

**5. Console UX cleanup**
- `410b1990` / `4da1ad2d` 删 `vectorSearchAvailable` 字段（前端 + 后端）。install dialog 已经在 matrix `unsupported` 分支 block 不支持平台，UI 不再需要二级提示
- `0bdabdd2` `/start` endpoint 每个 fire site 加 `app.log.info`，让 user 在 api.log grep 完整 pipeline

### Pending (post-#674)

- 健康轮询 UI 表征（current: polling 在 backend，UI 通过 `/api/services` 拉）— 可能不需要单独做
- 日志流（current: per-service log file 通过 `readLogTail` 拉，不流式）
- 依赖排序（current: 无显式依赖图，sidecars 互相独立）
- 模型下载进度（current: stdout 经 `appendLog` 写入 service log，UI 不解析进度条）

## Open Questions

- ThreadSidebar 去重时机：合入后立即做还是观察一轮？
- F102 embedding catch-up 当前是 polling 5s × 60 (5 min) 兜底 + push-based stdout marker fast path。Push 路径需要 sidecar 主动 emit marker；llm-postprocess 因后台异步 load 暂不接入 push（等模型 load 完再 emit marker 是更准的 readiness contract，作为 future work）。

## Lessons Learned (from #674)

- **跨进程通信选 polling 还是 push**：cat-cafe sidecar 是独立 Python 进程 + HTTP server，原本以为必须做 sidecar→API HTTP callback 才能 push，实际 spawn 已经在父进程里持有 child handle，**`child.stdout.on('data', cb)` 就是 push** —— TS event loop 在 stdout 有 chunk 时立刻 callback，跟 HTTP push 同语义但不需要新增 endpoint / 鉴权 / retry。
- **PowerShell `Invoke-WebRequest -Proxy <url>` 会自动用 logged-in Windows 凭证回 corp proxy 的 NTLM 407** — probe 看起来"通"实际是 SSPI 自动 auth。pip / huggingface_hub 没这能力。Probe 必须显式 `HttpClient + UseDefaultCredentials=$false + Credentials=$null` 才能模拟 pip 行为。
- **"Hook 注册 + fire 触发"语义**：默认 `unregisterOnSuccess: true` 适合 one-shot bootstrap，但对"每次 sidecar transition 都要 catch-up"用例必须 `false`；fire 不去重，依赖 hook 自己 idempotent (e.g. `embedPending` 在 pending=0 时立即 return)。
- **桌面客户端 atomic 升级语义**：前后端总是同一 commit ship，install 脚本里 silent fallback 没必要——console 传错就该 fail-fast。这就是 #674 把 11 处 install 脚本的 fallback 默认全删的依据。
- **`waitUntilHealthSettles` 接受 `'stopped'` 作终态对 spawn 等待场景错**：sidecar 启动初期 health probe 返 ECONNREFUSED → `classifyFetchError` → `'stopped'` 被当 terminal 立刻 return；spawn 等待必须只接受 `'running'`，跟 `autoStartEnabledServices` 的 `watchAndAnnounceReady` 行为对齐。
