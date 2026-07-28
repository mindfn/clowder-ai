---
feature_ids: [F273]
topics: [desktop, electron, updater, proxy, ipc, markdown, recovery]
doc_kind: implementation-plan
created: 2026-07-28
---

# F273 Update UX and Manual Recovery Implementation Plan

**Tracking:** PR #1105 post-merge field-validation findings
**Goal:** Make the existing desktop updater understandable and recoverable on proxied Windows systems without weakening its GitHub asset-integrity boundary.
**Acceptance Criteria:** AC-E1 the update prompt shows only the exact asset already selected for the current OS/architecture (Windows Setup.exe or matching macOS dmg) and exposes a clickable canonical release link; AC-E2 automatic download continues through Electron's default system-proxy session and emits safe proxy/redirect/status/phase/byte diagnostics without logging signed URLs at any error boundary; AC-E3 download failure, including update-directory creation failure, releases manager state and offers Retry, Download in Browser, and Cancel, with the awaited browser path opening only the exact canonical release page or exposing that URL for manual use; AC-E4 the main/renderer prompt bridge validates sender, version, platform, asset, and action, replays a pending prompt after renderer mount or reload, invalidates readiness on navigation or process loss, bounds presentation with a native fallback, and resolves at most once; AC-E5 existing asset selection, Range/ETag resume, size/digest verification, installer journal, portable fail-safe, and upgrade recovery behavior remain unchanged.
**Architecture cell:** `hub-action-surface`
**Map delta:** none
**Map delta why:** The web-rendered prompt is a desktop-owned action surface mounted in the existing AppShell. It adds no service, persistence owner, feed, or network boundary.
**Architecture:** The Electron main process owns one pending update-prompt transaction and sends a narrow serializable view model through a context-isolated preload bridge. The view model reuses the checker-selected `target.asset.name` and a closed platform enum; the AppShell does not infer the OS or parse a cross-platform release table. Renderer actions are admitted by a sender/version/action guard. Downloading remains in the main process through Electron's default session; the session is refreshed and inspected, not overridden. Native dialogs remain the fallback for download/install failures and gain a canonical manual-browser action.
**Tech Stack:** Electron 35, Node.js, React/Next.js, Electron IPC
**前端验证:** Yes

---

## Finish line and non-goals

Terminal behavior:

1. The update prompt displays the single checker-selected package for the current OS/architecture and a clickable `vX.Y.Z` link to the canonical GitHub release.
2. Download uses the same Electron default session that resolves the system proxy, and a field log can distinguish proxy decision, redirect, response, stream, timeout, and byte-count failures.
3. Any automatic-download failure leaves the user with a browser-download path that supports manual overwrite installation.
4. Reloading or mounting the renderer cannot lose or duplicate the prompt, and an untrusted frame cannot choose an update action or open an arbitrary URL.

Not in scope:

- a GitHub mirror, custom proxy configuration UI, or environment-variable proxy injection;
- rendering or filtering the complete GitHub release body inside the prompt;
- arbitrary URL opening from renderer payloads;
- changing the trusted asset tuple or installer execution boundary;
- silent background downloads or silent automatic installation.

## Grounding and invariants

| Invariant | Required behavior |
|---|---|
| INV-E1 — main owns update state | Renderer renders and requests actions; it never selects assets, downloads, verifies, or executes installers. |
| INV-E2 — one prompt transaction | At most one target is pending; a terminal action resolves exactly once. Renderer reload replays the same target. |
| INV-E3 — admitted IPC | Only the current main-window webContents, an exact pending version, and enumerated actions are accepted. |
| INV-E4 — canonical links | Release links are derived in main from `GITHUB_OWNER`, `GITHUB_REPO`, and a checker-validated semantic version. Renderer cannot supply an external URL. |
| INV-E5 — system proxy, no override | `session.defaultSession` remains authoritative. A best-effort proxy-config refresh and `resolveProxy(assetUrl)` provide diagnostics only. |
| INV-E6 — safe network logs | Logs may include proxy resolution text, redirect/response host, status, phase, and bytes. They must exclude redirect paths, signed query strings, tokens, and response headers. |
| INV-E7 — integrity unchanged | Manual fallback does not authorize automatic execution. Automatic execution still follows fresh GitHub metadata plus size/digest verification. |

## Stateful-object census

| Object | Owner | States / transitions | Adversarial cases |
|---|---|---|---|
| update prompt transaction | Electron main prompt controller | idle → pending → download/later/skip → idle | renderer not mounted, reload, duplicate action, stale version, wrong sender, window destroyed |
| renderer prompt view | AppShell component | absent → platform asset rendered → user action → absent | wrong platform, other-platform asset leakage, close/Escape, duplicate event |
| asset download | `downloadAsset()` | request → redirects → response → stream → verified or failed | system proxy refresh failure, connection close before response, redirect listener cancellation, partial bytes, signed URL logging |
| download recovery dialog | `UpdateManager` | failed → retry/manual/cancel | recursive retry while `_downloading`, canonical release URL, portable behavior |

### Prompt transition table

| Current state | Event | Admission | Result |
|---|---|---|---|
| idle | main requests prompt | validated target payload | store pending and send/replay view model |
| pending | renderer-ready | current main-window sender | resend same payload without resolving |
| pending | open-release | current sender + exact version | open canonical release page; remain pending |
| pending | download/later/skip | current sender + exact version | resolve once and clear pending |
| pending | stale version / unknown action / other sender | reject | no open, no resolve, no state change |
| pending | renderer navigation starts / process exits | main-window lifecycle event | mark renderer unavailable and start a bounded presentation timer |
| pending | renderer reload completes | new ready event from same main webContents | mark renderer ready and replay same payload |
| pending | presentation timer expires before renderer ready | same pending transaction | resolve through plain native fallback |
| pending | window destroyed/app shutdown | lifecycle owner cancels | resolve as later and clear pending |

## Implementation phases

### Phase 1 — RED: manager behavior and recovery

**Files**

- Modify: `desktop/update-manager.test.js`
- Modify: `desktop/update-installer.test.js`
- Add: `desktop/update-prompt-controller.test.js`

1. Add failing tests proving `_promptUpdate()` delegates the checker-selected platform asset and maps download/later/skip.
2. Add failing tests proving a download failure offers the three recovery actions and opens the exact release page for the manual action.
3. Add failing controller tests for replay, exact-once resolution, wrong sender, stale version, unknown action, release-link action, and destruction.
4. Add failing installer tests for default-session proxy refresh/resolution, explicit synchronous redirect following, phase/byte diagnostics, and absence of signed redirect text.

### Phase 2 — GREEN: main-process prompt and network diagnostics

**Files**

- Add: `desktop/update-prompt-controller.js`
- Modify: `desktop/update-manager.js`
- Modify: `desktop/update-installer.js`
- Modify: `desktop/main.js`

1. Implement a narrow prompt controller with injected `ipcMain`, main-window getter, external opener, and logger.
2. Inject `showUpdatePrompt()` into `UpdateManager`; retain a plain-text native fallback that recommends the same selected asset when the window is unavailable.
3. Change download failure actions to Retry / Download in Browser / Cancel.
4. Before download, best-effort refresh the default session's proxy config and log `resolveProxy(assetUrl)`.
5. Add safe redirect/response/failure logging; if the redirect event is observed, call `followRedirect()` synchronously as Electron requires.
6. Derive release URLs from validated versions in main only.

### Phase 3 — RED/GREEN: context-isolated renderer

**Files**

- Modify: `desktop/preload.js`
- Add: `packages/web/src/components/DesktopUpdatePrompt.tsx`
- Add: `packages/web/src/components/__tests__/DesktopUpdatePrompt.test.tsx`
- Modify: `packages/web/src/components/AppShell.tsx`
- Modify: relevant web type declaration for `window.desktopBridge`

1. Add failing component tests for Windows Setup, macOS architecture dmg, absence of the other platform's package, version/release links, and action messages.
2. Expose only subscribe/unsubscribe, ready/replay, action, and open-release calls through preload.
3. Mount the prompt once at the route-stable AppShell root.
4. Route external links through an HTTPS-only `setWindowOpenHandler`; deny Electron-created windows and internal navigation.

### Phase 4 — regression and field observability

**Files**

- Modify: `docs/features/F273-desktop-in-app-update.md`
- Modify: the focused tests above

1. Record the operator-approved override of the original native-dialog-only UI decision.
2. Run focused desktop and web tests, lint/typecheck/build, then the repository quality gate.
3. Render Windows and macOS prompts in an isolated browser-preview environment and capture the selected package, canonical link, platform-specific download label, and absence of the other platform's extension.
4. Rebuild the low-version Windows field package only after review and CI, then retest through Clash Verge using `main.log` proxy/redirect markers.

## RED adversarial test matrix

| Scenario | Expected |
|---|---|
| release body contains a cross-platform downloads table | body does not cross prompt IPC; only `target.asset.name` for the current OS/arch renders |
| prompt payload uses unsupported platform or an empty asset name | rejected before presentation |
| renderer registers after main discovered the release | ready/replay returns the pending prompt |
| renderer reloads while prompt pending | one view is replayed; main transaction remains one |
| duplicate download click | first accepted action resolves; later actions are ignored |
| iframe/devtools/other webContents sends action | rejected with no state change |
| renderer sends version different from pending | rejected |
| renderer attempts arbitrary external URL | impossible through bridge; main derives the only release URL |
| `forceReloadProxyConfig()` or `resolveProxy()` rejects | diagnostic log records failure; download still uses default session |
| GitHub redirect includes a signed query | log contains only destination host/status; `followRedirect()` is called synchronously |
| connection closes before response | failure log reports request phase and zero/known bytes; user gets manual-browser action |
| stream closes after partial bytes | failure log reports stream phase and received count; existing resume metadata behavior remains |
| upper manager receives an error containing a signed URL | log and dialog contain a redacted message; signed query is absent |
| update directory cannot be created | recovery actions appear and `_downloading` is released for the next attempt |
| default browser rejects the release-page request | rejection is handled; user sees the canonical URL for manual opening |
| renderer was ready, then navigation starts or its process exits | readiness resets; a pending prompt receives a bounded native fallback |

## Verification commands

```bash
node --test desktop/update-manager.test.js desktop/update-installer.test.js desktop/update-prompt-controller.test.js
pnpm --filter @cat-cafe/web test -- DesktopUpdatePrompt
pnpm --filter @cat-cafe/web typecheck
pnpm test
pnpm build
```
