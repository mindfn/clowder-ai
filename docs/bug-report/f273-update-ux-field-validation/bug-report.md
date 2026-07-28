---
feature_ids: [F273]
topics: [desktop, electron, updater, proxy, markdown, windows]
doc_kind: bug-report
created: 2026-07-28
updated: 2026-07-28
tips_exempt:
  reason: Correctness and recovery fixes for the existing desktop updater; no new top-level capability.
---

# F273 Windows field validation: update prompt and download recovery

## Bug diagnosis capsule

| Field | Evidence-backed diagnosis |
|---|---|
| **1. Symptom** | A packaged Windows v0.10.0 client detects v0.12.0, but the update dialog shows literal Markdown tokens and the automatic download ends with `net::ERR_CONNECTION_CLOSED`. |
| **2. Evidence** | `main.log` records `Update available: v0.12.0` followed about eight minutes later by `Download failed: net::ERR_CONNECTION_CLOSED`. The updates directory contains neither the installer nor resume metadata. The dialog screenshot shows literal `#`, backticks, and `**`. |
| **3. Root cause** | `_promptUpdate()` slices raw release Markdown and sends it to Electron's native `dialog.showMessageBox`, which only renders plain text. The download path uses Electron `net.request`, but logs only the terminal error, so the effective system-proxy decision, redirect chain, response phase, and received byte count are invisible. Field evidence does not justify bypassing Electron's system proxy: Clash/Mihomo fake-IP resolution to `198.18.0.0/15` is expected, while direct `curl`/`Test-NetConnection` probes do not exercise Electron's proxy session. |
| **4. Diagnosis strategy** | Trace release check → update prompt → renderer action → `downloadAsset()` → redirects/response/write stream. Preserve Electron's default session and inspect it with `forceReloadProxyConfig()` plus `resolveProxy()`. Record only safe proxy/host/status/phase metadata; never signed redirect query strings. |
| **5. Timeout strategy** | Keep the existing bounded request/download timeout behavior. Unit tests use deterministic fake requests, responses, IPC senders, and renderer events; no live GitHub, runtime service, production Redis, or local reserved port is used. |
| **6. Early warning** | Log download start, resolved proxy mode, each safe redirect host/status, response host/status, failure phase, and received bytes. Retain the existing integrity, asset-size, ETag, Range, and journal checks. |
| **7. User-visible correction** | Show a compact in-app offer with the single asset already selected for the current OS and architecture: Windows Setup.exe or the matching macOS dmg. Keep the exact release link for complete notes. Automatic download remains primary. A failed download offers Retry, Download in Browser, or Cancel so a user can download and overwrite-install manually. |
| **8. Acceptance** | Red-to-green tests cover platform-specific asset presentation, absence of other-platform packages, safe external links, renderer reload/replay and readiness invalidation, untrusted IPC rejection, ordinary-browser isolation, default-session proxy diagnostics, redirect following, manager-boundary log redaction, update-directory failure recovery, and rejected-browser-opener recovery. |

## Reproduction record

1. Install the exact upstream-main v0.10.0 Windows field package.
2. Launch while v0.12.0 is the newest stable release.
3. Observe that the update dialog shows raw release Markdown.
4. Select **Download** while Windows system proxy points to Clash Verge.
5. After the request fails, observe only `net::ERR_CONNECTION_CLOSED` and no partial file or resume metadata.

## Safety boundary

- Do not inject `HTTP_PROXY`, `HTTPS_PROXY`, or a hard-coded proxy into the app.
- Do not add a release mirror or accept arbitrary download/open-external URLs.
- Do not log signed GitHub asset URLs or query parameters.
- An ordinary browser has no Electron `desktopBridge`, performs no desktop update check, and renders no update prompt. Browser visual tests may inject a mock bridge, but that is test-only behavior.
- The only manual-download target is the canonical repository release page derived from the validated semantic version.
- Automatic downloads still require GitHub API asset identity, size, and digest validation before execution.

## Operator boundary clarification

> “我注意到 浏览器的版本也在提示新版本的这个只是你们测试吧；正常的源码应该不会提示这个吧；应该只有安装包才会提示吧；”
>
> “如果是Windows就推荐Windows的setup安装包 macos就提示mac对应的dmg 没必要提示信息都显示吧；因为用户点击download的时候你也是需要下载合适的版本的包的”
>
> “升级的弹窗有点太宽了；可以窄一点的”

Confirmed: the observed browser prompt was a Playwright visual test that explicitly injected a mock Electron bridge and v0.10.0 → v0.12.0 payload. In normal browser execution, `window.desktopBridge` is absent, the component remains empty, and no update request originates from the web app. Packaged Electron is the production prompt owner; a developer who deliberately launches the Electron desktop shell can exercise the same desktop-only path.

The final prompt now consumes the exact `target.asset.name` already selected by the trusted update checker. Windows receives `platform=windows` plus `ClowderAI-Setup-{version}.exe`; macOS receives `platform=macos` plus the current architecture's `ClowderAI-{version}-{arm64|x64}.dmg`. The GitHub release body and its cross-platform download table no longer cross the prompt IPC boundary.

The compact platform recommendation also removes the old wide release-notes layout. The modal is capped at `max-w-lg`; long asset names use safe text wrapping, and the footer keeps the three existing actions.

## Fresh-context repair record

A pre-review adversarial pass found four recovery-boundary gaps after the initial implementation:

1. The installer boundary redacted URL-bearing errors, but the manager logged and displayed the original exception again.
2. Update-directory creation happened after setting `_downloading` and before entering `try/finally`, so a filesystem failure could permanently strand the lock.
3. The browser recovery action did not await Electron's Promise-returning opener.
4. Renderer readiness stayed true after navigation or process loss, so a later prompt could miss its native presentation timeout.

Focused tests reproduced all four failures before the correction. The manager now sanitizes at its own boundary, owns directory creation inside the existing `try/finally`, awaits browser recovery and exposes a canonical manual URL when it fails, while Electron lifecycle events invalidate renderer readiness and start a bounded fallback for any pending prompt.
