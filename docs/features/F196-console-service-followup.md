---
feature_ids: [F196]
related_features: [F190, F195, F102]
topics: [services, console, install, sidecar, lifecycle, embedding, proxy, cross-platform]
doc_kind: spec
created: 2026-05-13
---

# F196: Console & Service Followup — 跨平台 install / sidecar lifecycle / embedding consistency

> **Status**: Implemented (branch), Linux verified, Windows x86 + Mac pending | **Owner**: Ragdoll | **Priority**: P1

## Why

F190 (#662, AppShell + Settings skeleton) 和 F195 (#669, Settings feature migration) 上线后，下游的 service install + sidecar lifecycle + embedding catch-up 出现了一串相互独立的边界 bug。集中表现：

- **跨平台 install 失败**：Windows ARM64 PowerShell 5.1 的 quoting / Add-Member 副作用 / PE header arch 误判；Linux uv 漏跑 ensurepip 校验；sqlite-vec 主包 ^0.1.6 没装上 linux-arm64 prebuilt。
- **代理 / 镜像 fallback 误判**：内网 corporate proxy 需要 NTLM 认证时 PowerShell `Invoke-WebRequest -Proxy` 会用 logged-in 凭证 auto-auth，让 probe 看起来"通"但 pip 实际 401。代理不可用时镜像可达性也没二次校验。
- **Embedding 模型显示错**：console "索引统计 → Embedding" 显示老的 hardcoded `qwen3-embedding-0.6b`，跟 sidecar 实际跑的 BGE / Jina 不一致。改模型后旧 vectors 没清，meta 被静默盖成新 modelId → 语义搜索结果在旧向量空间里查新查询，错而无 error。
- **Console 手动 click 启动后 catch-up 不跑**：autostart 路径 fire `'started'` event，console `/api/services/:id/start` endpoint 之前没 fire；fire 后 catch-up hook 第一次跑完 unregister（默认行为），导致 disable→enable 切换后再 fire 没人接；polling watcher 在 sidecar 启动初期 ECONNREFUSED 时误判为终态 `'stopped'` 提前 return 不 fire。
- **Install 脚本 hardcoded fallback** 跟 `recommendation-matrix.yaml` 两条真相源；直接命令行跑脚本会装不一致的模型。

## What (PR #674)

按主题分组的 fix 链（30+ commits）：

### 1. Cross-platform install bootstrap

- `bf6bdb19` Windows ARM64 Python 解析改读 PE header arch（替代 `platform.machine()`，后者在 Prism emulator 下会假报 ARM64）
- `16fbc356` `Try-*` PowerShell 函数移除 `Add-Member -PassThru`（implicit pipeline output → caller 收 array of 2 同 obj）
- `827901ab` `_try_uv / _try_pyenv / _try_brew` 也必须跑 `_python_version_ok` ensurepip 校验
- `78319d9c` PE header arch 解析逻辑前置
- `093d40b4` install / uninstall 加 sentinel log，silent skip 暴露可见

### 2. sqlite-vec 平台兼容

- `eaa4403a` + `32ef1ad7` `sqlite-vec ^0.1.6 → ^0.1.9`（0.1.6 上游漏发 `sqlite-vec-linux-arm64@0.1.6` prebuilt，导致 ARM 用户 silent 跳过 optional dep）

### 3. 模型选型治理（单源真相）

- `14c153e5` 删 `EmbedConfig.embedModel` 的 `'qwen3-embedding-0.6b' | 'multilingual-e5-small'` union 类型 + `VALID_EMBED_MODELS` 白名单；默认值改 `'unknown'` sentinel，让 sidecar `/health` probe 接管真模型 id
- `d76a1659` 11 处 install 脚本 fallback model 改 fail-fast（缺 env → 中文错误 + `exit 1`，强制走 console install endpoint 的 matrix resolver）
- `b14c34c5` x64 默认推 BGE-small-zh（不是 jina）
- `83aa04c7` jina 模型 config.json 老的 `attn_implementation="torch"` 在新 transformers 被拒，runtime override 'eager'
- `b29c04d0` 所有 server scripts 模型默认从 hardcoded 改 env-driven
- `658b8c92` 抽 `resolveSelectedModel` 到 `service-model-resolver.ts` —— autostart / `/start` / install endpoint 共享同一优先链（body.model > cfg.selectedModel > matrix recommendation default）

### 4. 代理 / 镜像 fallback

- `f3a86c0d` PowerShell `Sync-SystemProxy` probe 改用 `HttpClient + UseDefaultCredentials=false + Credentials=null`，强制 anonymous 探测（不让 .NET 自动 NTLM auth 误判 corp proxy 可用）
- `9e998c4f` Write-ProxyGuidance / `_print_proxy_guidance` 去 `cntlm/PX` 硬编码示例，改"方案 A 配代理（带 auth 标准 URL）/ 方案 B 配镜像源"通用文案
- `658b8c92`（同上）`python-resolve.ps1::Sync-ResolverSystemProxy` 加 sibling `Test-ResolverProxyAnonymous`，跟 `prereq-check.ps1` 一致，不再 bypass anonymous probe
- 14c153e5（同上）Assert-Network 加 mirror 可达性校验，pypi.org + 清华都不通时打印 actionable WARNING

### 5. Embedding catch-up 链路

- `b7da7863` `'started'` event hook 内主动 `await embedding?.load()` 重新 probe `/health`，拿 sidecar 真实 `modelId`（避免 fallback 到 `parseEmbedConfig` 默认 `'qwen3-embedding-0.6b'`）
- `d1ce4fa8` `/api/services/:id/start` + install endpoint auto-start branch 都 fire `'started'`（之前只有 autostart fire）
- `e551dc36` catch-up hook 注册带 `{ unregisterOnSuccess: false }`，让 hook 在用户 disable→enable / 重启 sidecar 等多次 `'started'` 触发场景下都能跑
- `09eba460` 新 helper `watchForRunningAndFire` 替代 `waitUntilHealthSettles`：5s × 60 polling, **只接受 `'running'` 终态**（不让 sidecar 启动初期 ECONNREFUSED 误判为终态 `'stopped'`）
- `95a0b192` **Push-based ready signal**：spawn `stdio: 'pipe'`，新 helper `wireUpSidecarReadyListener` parse stdout 的 `__CATCAFE_SIDECAR_READY__` marker（embed/whisper/tts 各加 fastapi `@app.on_event("startup")` hook 在 uvicorn bind port 那一刻输出 marker）。llm-postprocess 模型后台异步 load 不发 marker，polling 兜底
- `658b8c92`（同上）`embedPending` 入口先 `checkMetaConsistency`，model/dim 变化 → `clearAll` → 后续 SELECT-NOT-IN 自然报全部 docs 为 pending → re-embed all（修 P1 静默错搜索结果）

### 6. Console UI

- `410b1990` / `4da1ad2d` 删 `vectorSearchAvailable` 字段（前端 + 后端）。install dialog 已经在 matrix `unsupported` 分支 block 不支持平台，UI 不再需要二级提示"无 binary"

### 7. 诊断 log

- `0bdabdd2` `/start` endpoint 每个 fire site 加 `app.log.info`：spawn → watcher poll → settle → fire → catch-up，让 user 在 api.log grep 完整 pipeline

## Acceptance Criteria

- [x] AC-1: Linux ARM (Ubuntu) embedding install + autostart + console disable/enable verify pass — `embed catch-up — probed=true embedded=N pending=0` 在 api.log 出现，UI vectors 跟 docs 一致
- [x] AC-2: codex (砚砚) P1×2 + P2×2 review pass, `658b8c92` re-review approved
- [ ] AC-3: Windows x86 (内网 cntlm/PX 代理 + 系统认证代理) install + 启动 verify
- [ ] AC-4: Mac (darwin arm64) embedding/whisper/tts/llm 完整 install + 启动 verify
- [ ] AC-5: Upstream maintainer review + merge

## Dependencies

- F190 (#662): AppShell + Settings 骨架（本 PR 修复 Settings 内 Service 面板)
- F195 (#669): Settings feature migration（本 PR 继续完善 service lifecycle）
- F102: Memory adapter refactor（本 PR 修 embed catch-up hook + meta consistency）

## Open

- F102 embedding catch-up 当前是 polling 5s × 60 (5 min) 兜底 + push-based stdout marker fast path。Push 路径需要 sidecar 主动 emit marker；llm-postprocess 因后台异步 load 暂不接入 push（等模型 load 完再 emit marker 是更准的 readiness contract，作为 future work）。
- `service-model-resolver.ts` 现在被 3 处 import；如果 services 数量继续增长，可能要把"哪个 service 走 matrix 哪个不走"做成 manifest 字段而不是隐式 default。

## Related Lessons

- 跨进程通信选 polling 还是 push：cat-cafe sidecar 是独立 Python 进程 + HTTP server，原本以为必须做 sidecar→API HTTP callback 才能 push，实际 spawn 已经在父进程里持有 child handle，**`child.stdout.on('data', cb)` 就是 push** —— TS event loop 在 stdout 有 chunk 时立刻 callback，跟 HTTP push 同语义但不需要新增 endpoint / 鉴权 / retry。
- PowerShell `Invoke-WebRequest -Proxy <url>` 会**自动**用 logged-in Windows 凭证回 corp proxy 的 NTLM 407 — probe 看起来"通"实际是 SSPI 自动 auth。pip / huggingface_hub 没这能力。Probe 必须显式 `HttpClient + UseDefaultCredentials=$false + Credentials=$null` 才能模拟 pip 行为。
- "Hook 注册 + fire 触发"语义：默认 `unregisterOnSuccess: true` 适合 one-shot bootstrap，但对"每次 sidecar transition 都要 catch-up"用例必须 `false`；fire 不去重，依赖 hook 自己 idempotent。
