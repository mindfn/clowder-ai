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
| **7. User-visible correction** | Render release notes in the app with a clickable exact release link. Automatic download remains primary. A failed download offers Retry, Download in Browser, or Cancel so a user can download and overwrite-install manually. |
| **8. Acceptance** | Red-to-green tests cover Markdown rendering, safe external links, renderer reload/replay, untrusted IPC rejection, default-session proxy diagnostics, redirect following, safe log redaction, and the manual-download fallback. |

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
- The only manual-download target is the canonical repository release page derived from the validated semantic version.
- Automatic downloads still require GitHub API asset identity, size, and digest validation before execution.
