# Review Request: F273 updater field correction

Review-Target-ID: f273
Branch: fix/f273-update-ux-fallback
Base: `origin/main@7207936a3`
Superseded review HEAD: `e345f7ebb`
Exact review HEAD: supplied in the formal handoff; it must include this packet and the refreshed platform-specific screenshots

## What

- Replace the native plain-text update offer with a context-isolated AppShell modal that shows only the checker-selected package for the current platform/architecture plus a main-owned canonical release link.
- Keep automatic download on Electron's default system-proxy session while adding bounded, redacted proxy/redirect/response/phase/byte diagnostics.
- Add Retry / Download in Browser / Cancel recovery without weakening installer identity, size, digest, resume, journal, or execution checks.
- Bound renderer presentation across mount, navigation, reload, and process loss; reject untrusted/stale/replayed IPC.
- Close four fresh-context recovery findings: upper-boundary URL leakage, sticky download lock after directory failure, rejected browser opener, and stale renderer readiness.

## Why

Windows field validation proved that v0.10.0 could discover v0.12.0, but the native dialog exposed literal Markdown and an eight-minute `net::ERR_CONNECTION_CLOSED` left neither actionable diagnostics nor a browser recovery path. The repair must preserve Electron's system proxy and the existing trusted asset tuple rather than injecting a proxy or mirror.

## Original Requirements

> A packaged Windows v0.10.0 client detects v0.12.0, but the update dialog shows literal Markdown tokens and the automatic download ends with `net::ERR_CONNECTION_CLOSED`.
> “正常的源码应该不会提示这个吧；应该只有安装包才会提示吧。”
> “如果是Windows就推荐Windows的setup安装包 macos就提示mac对应的dmg……因为用户点击download的时候你也是需要下载合适的版本的包的。”
> “升级的弹窗有点太宽了；可以窄一点的。”

- Source: `docs/bug-report/f273-update-ux-field-validation/bug-report.md`
- Please judge the deliverable against both field recovery and the ordinary-browser isolation boundary above.

## Tradeoff

- No hard-coded proxy, proxy environment injection, mirror, alternate downloader, or arbitrary external URL.
- The renderer owns presentation only; main retains release/version/action authority and all download/install state.
- The renderer does not parse release Markdown or infer the OS. Main reuses the exact asset already selected by `selectUpdateTarget()` and sends only `windows|macos + assetName`; the compact offer is capped at `max-w-lg`.
- Native dialogs remain the bounded fallback when the renderer or automatic download cannot complete.
- `did-start-loading` and `render-process-gone` invalidate readiness even during benign navigation; with no pending prompt this is a no-op, and a trusted ready event clears the timer.
- The archived browser screenshot uses an explicitly injected mock Electron bridge. This keeps the ordinary web app inert while exercising the real component.

## Architecture Ownership

Architecture cell: `hub-action-surface`
Map delta: none
Why: The modal is a desktop-owned action surface mounted in the existing AppShell. The correction adds no service, persistence owner, feed, network boundary, or parallel infrastructure abstraction.

Please reviewer check:

- the diff is consistent with `Map delta: none`;
- no parallel `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding` was introduced;
- the renderer bridge remains a narrow extension of the existing desktop boundary.

## Open Questions

### Technical OQ

1. Can any renderer-supplied URL, stale version, child frame, duplicate action, or destroyed window cross the main-owned IPC boundary?
2. Can any signed asset path/query re-enter logs or dialogs through a higher error boundary?
3. Do directory creation, browser launch, renderer navigation/crash, redirect, response, and stream failures all release their state owner and leave a visible bounded recovery path?
4. Does the ordinary browser remain inert while packaged Electron can replay exactly one pending prompt?
5. Does `desktop.build.files` close the full local JavaScript dependency graph reachable from `main.js`?
6. Is the displayed recommendation exactly the asset that `downloadAndInstall(target)` will receive, with no other-platform package exposed?

### Value OQ

None.

## Fresh-Context Findings

Agent: [砚砚/gpt-5.6-terra🐾]
SHA scanned: `4fac84c26`
Total findings: 4 (0 P1, 4 P2, 0 P3)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | Manager re-logged URL-bearing errors after installer sanitization | fixed in `d1965ef83`; boundary regression test added | Closed |
| FC-2 | `mkdirSync` failure stranded `_downloading` | fixed in `d1965ef83`; two-attempt recovery test added | Closed |
| FC-3 | Browser fallback rejection was unhandled | fixed in `d1965ef83`; visible canonical manual URL test added | Closed |
| FC-4 | Renderer readiness survived reload/crash and could hang the prompt queue | fixed in `d1965ef83`; lifecycle invalidation/timeout tests added | Closed |

Terra independently reproduced all four corrected paths and confirmed no new P1/P2 within that remediation delta. This was finding closure only, not a formal verdict.

Formal reviewer: annotate findings as `[FC:covered]`, `[FC:new]`, or `[FC:N/A]`.

## Next Action

Perform a fresh, exact-HEAD review against `origin/main@7207936a3`. Independently rerun the highest-risk desktop, packaging, browser-isolation, and signed-URL cases. Return a named APPROVE or REQUEST-CHANGES verdict with P1/P2/P3 severity and exact evidence.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f273/opus`
- Start Command: `pnpm review:start --web-port=3231 --api-port=3232`
- Ports: `web=3231`, `api=3232`
- Safety: detached/read-only HEAD, isolated memory/test data, no runtime Redis, no production service, no reserved port, and no runtime config changes.

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
```

The targeted desktop and packaging tests do not import API `dist/`; build `@cat-cafe/api` only if expanding the review to tests that do.

## Self-check evidence

### Spec compliance

- The exact selected Windows Setup or current-architecture macOS dmg is shown; the GitHub release body and cross-platform download table do not cross prompt IPC.
- Complete release notes remain available through the main-owned exact-version link.
- Electron default-session proxy remains authoritative; proxy refresh/resolution is diagnostic and best-effort.
- Renderer actions are enumerated and admitted only for the current main frame and exact pending version.
- Manual recovery cannot authorize automatic execution; existing asset tuple and digest verification remain unchanged.
- Ordinary browsers have no desktop bridge, make no updater request, and render no prompt.

### Tests

```text
node --test desktop/*.test.js
  159 passed, 0 failed

node --test packages/api/test/build-script-cross-platform.test.js
  8 passed, 0 failed

pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/DesktopUpdatePrompt.test.tsx
  7 passed, 0 failed

env -u NODE_ENV -u REDIS_URL pnpm --filter @cat-cafe/api run test:public
  16,690 passed, 0 failed, 28 skipped

pnpm check
  exit 0

pnpm lint
  exit 0; existing warnings only

pnpm -r --if-present run build
  exit 0

git diff --check
  passed
```

The isolated manager dogfood probe produced:

```json
{"dialogTitles":["Download Failed","Could Not Open Browser"],"signedUrlRedacted":true,"manualUrlVisible":true}
```

### Browser evidence

- Screenshots: `docs/bug-report/f273-update-ux-field-validation/artifacts/update-modal-v0.10.0-to-v0.12.0.png` and `update-modal-macos-arm64-v0.10.0-to-v0.12.0.png`.
- Exact component, isolated Next.js production server on web 3231, explicit Windows and macOS mock `desktopBridge` payloads.
- DOM verified the compact `max-w-lg` width, dialog semantics, canonical link, versions, single selected asset, platform-specific download label, and absence of the other platform's extension.
- Ordinary-browser regression deletes `window.desktopBridge` and asserts empty output.
- Server/browser/temp route were removed and port 3231 was closed.

### Artifact gate

- Root worktree media/design artifact scan: empty.
- Root committed-diff media/design artifact scan: empty.
- Screenshot is intentionally archived under the F273 bug-report artifact directory.
- No generated build output is tracked.

### Related documents

- Plan: `feature-specs/2026-07-28-f273-update-ux-fallback.md`
- Feature: `docs/features/F273-desktop-in-app-update.md`
- Field diagnosis: `docs/bug-report/f273-update-ux-field-validation/bug-report.md`
- Quality gate: `docs/bug-report/f273-update-ux-field-validation/quality-gate.md`

[砚砚/gpt-5.6-sol🐾]
