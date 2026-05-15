---
feature_ids: [F198]
related_features: [F190, F102]
topics: [services, install, sidecar, automation, lifecycle]
doc_kind: spec
created: 2026-05-15
---

# F198: Unified Service Install Pipeline — 抽象通用安装流程，service 只声明差异

> **Status**: in-progress (implemented in PR #674, pending merge) | **Owner**: Ragdoll | **Priority**: P1 — user explicit "no follow-up" decision: 一次性做完不留 followup

## Why

team experience (during #674 verify):
> "我理解我们这些其实是比较通用的问题和流程的? windows/linux/mac/ 内网外网的 有代理无代理 然后下载安装。这个是不是应该考虑抽象下作为一个统一的模板的；因为好像不同的服务的差异主要就是下载安装的内容不太一样；但是除了这个都是这个样子。这样子我只需要确认某个环境下某个服务下载安装正常，那其他服务基本上就一定没问；除非 ffmpeg 这种需要用户自己装的之外。"

PR #674 验证过程中暴露的根本矛盾：环境/代理/镜像/重试的逻辑明明通用（OS proxy 探测、PIP_INDEX_URL 优先级、HF retry、CAT_CAFE_HOME 路径），但因为分散在 4 个 install scripts 各 70-100 行的副本里，每次改流程都要四改、漏一个就出 inconsistency bug（embedding 装好 whisper 挂的本质就是 ad-hoc surface 多）。

## What

抽出**统一安装管道**。Service 差异退化到一个 declarative manifest：

```yaml
# service-install.yaml (per service)
service: whisper-stt
pip_deps:
  - mlx-whisper            # arm64 only
  - fastapi
  - uvicorn
  - python-multipart
  - 'httpx[socks]'
  - 'huggingface_hub[hf_xet]'
pre_download_model_env: WHISPER_MODEL    # which env points at HF model id
extra_checks:
  - ffmpeg                 # binary required, install script fails fast if missing
```

通用流程（一处实现，所有服务共享）：

```
1. ensurePython           ← python-resolve.{sh,ps1}
2. check_disk_space       ← prereq-check.{sh,ps1}
3. check_network          ← prereq-check.{sh,ps1}
     ├ OS system proxy 探测 + per-source probe + NO_PROXY 分类
     ├ PIP_INDEX_URL / PIP_EXTRA_INDEX_URL 注入策略
     └ HTTP_PROXY 注入（任一源 proxy mode 通时）
4. check_extras           ← new: 验证 manifest.extra_checks（如 ffmpeg）
5. uninstall_legacy_paths ← new: 清 legacy ~/.cat-cafe 残留 venv
6. venv_create            ← uv venv / python -m venv
7. pip_install            ← pip install <manifest.pip_deps> --quiet 带 retry
8. pre_download_model     ← snapshot_download(env[manifest.pre_download_model_env]) 带 3x retry + HF_HUB_DOWNLOAD_TIMEOUT
9. report_done            ← 输出"安装完成"+ idempotency snapshot
```

任何一处 fix 写一遍，全 service 受益。

## Acceptance Criteria

- [x] AC-1: 4 个 `.sh` install scripts 退化到 declarative inputs + sourced `install-template.sh`：22 / 24 / 67 / 19 lines (vs 67 / 97 / 102 / 70 之前 — simple services 缩 70%+，tts 保留 67 行是因为非-arm64 piper voice 离线下载是真特殊 case，via POST_INSTALL_HOOK_OTHER)
- [x] AC-2 (partial): `.ps1` 端 retry 路径集中——`prereq-check.ps1` 新增 `Invoke-ModelDownloadWithRetry` helper 支持 `snapshot` / `faster_whisper` / `fastembed` 三种 loader。4 个 `.ps1` install scripts 已切到 helper（不再各自 inline `& $VenvPython -c "snapshot_download..."` 无重试）。**Full `.ps1` template 抽象未做**——Windows-specific quirks (CUDA index URL / ARM64 interpreter reject / SAPI vs piper vs edge-tts 3 路径 / fastembed py_rust_stemmers stub) 让 surface 比 `.sh` 大，强行抽象 risk > 收益；retry-only collapse 已经消除主要 fan-out 痛点
- [x] AC-3: 单 service smoke test 仍由人工跨平台验收（在 #674 中走 Mac + Linux + Windows 三环境）
- [x] AC-4: 新增 `.sh` service 路径：22 行 declarative + source template
- [x] AC-5: Backward-compatible: manual `bash <svc>-install.sh` 仍工作（template 内部 `set -euo pipefail`，error 路径 propagate exit code）

## Open Questions

1. **实现语言**：bash template (4 scripts → 4×4 lines + shared 200 lines) vs TS backend `installService()` function (TS 直接 spawn python/pip, 没 bash 中间层)。bash template 更接近现状，TS 重构 surface 更大但 testable
2. **配置格式**：YAML vs JSON manifest。YAML 更人类友好，JSON 已经在 services.json 里 — pick consistency
3. **PowerShell 端的模板形态**：dot-source `install-template.ps1` 还是单一 `Install-Service -Manifest <path>` cmdlet
4. **Backward compatibility**：manual install 跑时 manifest 怎么 locate？env override `SERVICE_MANIFEST=...` 还是 script-side default
5. **是否覆盖 `qwen3-asr-server.sh` 这种特殊 case**（manifest 里没有 / install 流程不一样）—— scope decision

## Dependencies

- F190（Console Settings Shell）— PR #674 实际把 install/uninstall/start/stop async + per-host NO_PROXY + retry + system proxy 全做好，本 feature 是把这些**散落的 helpers 收编成一个 manifest-driven pipeline**。

## Lessons That Drove This Spec

- PR #674 共 30+ commits，里面 ~10 个是"同一 fix 在 4 个 install scripts 改了 4 遍"（retry / CAT_CAFE_HOME init / system proxy probe / extra_index_url fallback）。这种 fan-out 是 ad-hoc surface 的直接征兆。
- "embedding 装好 whisper 挂"——同一环境下不同 service 表现不一致，本质是 HF CDN routing 间歇性，但 user 体感是"流程不可靠"。Unified pipeline 让"单 service smoke = 整套环境绿"成立，减少这种困惑。
- snapshot_download retry 在 #674 加了 3 次但是 4 个 install scripts 都改一遍——典型 copy-paste tax。

## Out of Scope

- 不改 backend API endpoint shape（`/api/services/:id/install` 接口不变）
- 不改 frontend UI（卡片 + 进度 + 错误展示仍按 #674 的形态）
- 不改 services.json schema（service 配置仍走 ServiceConfig / ServiceManifest）

只重构 install/uninstall script 的**实现层**。

[宪宪/Opus-47🐾]
