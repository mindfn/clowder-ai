---
feature_ids: [F273]
topics: [desktop, electron, updater, proxy, ipc, markdown, recovery]
doc_kind: implementation-plan
created: 2026-07-28
---

# F273 Update UX and Manual Recovery Implementation Plan

**Tracking:** PR #1105 post-merge field-validation findings
**Goal:** Make the existing desktop updater understandable and recoverable on proxied Windows systems without weakening its GitHub asset-integrity boundary.
**Acceptance Criteria:** AC-E1 the update prompt shows only the exact asset already selected for the current OS/architecture (Windows Setup.exe or matching macOS dmg) and exposes a clickable canonical release link; AC-E2 automatic download continues through Electron's default system-proxy session and emits safe proxy/redirect/status/phase/byte diagnostics without logging signed URLs at any error boundary; AC-E3 download failure, including update-directory creation failure, releases manager state and offers Retry, Download in Browser, and Cancel, with the awaited browser path opening only the exact canonical release page or exposing that URL for manual use; AC-E4 automatic checks are silent for no-update and failure results, while every manual check produces one in-app result (available, up-to-date, or failed with the canonical Releases path); AC-E5 the main/renderer prompt bridge validates sender origin, current main frame, prompt kind, version, platform/asset where applicable, and action, durably replays a pending prompt after renderer mount or reload, has no presentation timeout or native update-result fallback, and resolves at most once; AC-E6 existing asset selection, Range/ETag resume, size/digest verification, installer journal, portable fail-safe, and upgrade recovery behavior remain unchanged; AC-E7 Electron denies all renderer-created popup windows while handing remote HTTPS links and exact app/API/preview loopback-origin links to the system browser, rejecting other HTTP origins, unsafe schemes, and malformed URLs.
**Architecture cell:** `hub-action-surface`
**Map delta:** none
**Map delta why:** The web-rendered prompt is a desktop-owned action surface mounted in the existing AppShell. It adds no service, persistence owner, feed, or network boundary.
**Architecture:** The Electron main process owns release discovery, comparison, the selected asset tuple, and one pending typed result transaction. The AppShell subscribes first, then announces simple trusted-main-frame readiness and receives any pending result in the same invoke response; there is no document-token state machine or presentation timer. Renderer actions are admitted by prompt kind, current main-frame identity, version, and a closed action set. Downloading remains in the main process through Electron's default session; native dialogs remain only for download/install recovery, never for ordinary update-check results.
**Tech Stack:** Electron 35, Node.js, React/Next.js, Electron IPC
**前端验证:** Yes

---

## Finish line and non-goals

Terminal behavior:

1. The update prompt displays the single checker-selected package for the current OS/architecture and a clickable `vX.Y.Z` link to the canonical GitHub release.
2. Download uses the same Electron default session that resolves the system proxy, and a field log can distinguish proxy decision, redirect, response, stream, timeout, and byte-count failures.
3. Any automatic-download failure leaves the user with a browser-download path that supports manual overwrite installation.
4. Automatic no-update/failure checks stay silent; manual checks always render one typed in-app result. Reloading or mounting the renderer cannot lose or duplicate that result, and an untrusted frame cannot choose an update action or open an arbitrary URL.

Not in scope:

- a GitHub mirror, custom proxy configuration UI, or environment-variable proxy injection;
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
| update prompt transaction | Electron main prompt controller | idle → pending available/up-to-date/check-failed/ready-to-install → admitted terminal action → idle | renderer not mounted, reload, duplicate action, stale version, wrong sender, window destroyed |
| renderer prompt view | AppShell component | absent → platform asset rendered → user action → absent | wrong platform, other-platform asset leakage, close/Escape, duplicate event |
| asset download | `downloadAsset()` | request → redirects → response → stream → verified or failed | system proxy refresh failure, connection close before response, redirect listener cancellation, partial bytes, signed URL logging |
| download recovery dialog | `UpdateManager` | failed → retry/manual/cancel | recursive retry while `_downloading`, canonical release URL, portable behavior |

### Prompt transition table

| Current state | Event | Admission | Result |
|---|---|---|---|
| idle | main requests prompt | validated target payload | store pending and send/replay view model |
| pending | renderer-ready | trusted current main-frame sender | return the same payload in the readiness response without resolving |
| pending | open-release | current sender + exact version | open canonical release page; remain pending |
| pending | download/later/skip | current sender + exact version | resolve once and clear pending |
| pending | stale version / unknown action / other sender | reject | no open, no resolve, no state change |
| pending | renderer navigation commits / process exits | main-window lifecycle event | mark renderer unavailable; retain the pending result |
| pending | renderer reload completes | new ready event from the trusted current main frame | mark renderer ready and return the pending result |
| pending | window destroyed/app shutdown | lifecycle owner cancels | resolve as later and clear pending |

## Field round 10 — straight-line update-check contract (operator override, 2026-08-04)

**Finish line:** GitHub release discovery and semantic-version comparison produce one typed result; automatic checks surface only `available`, while manual checks surface exactly one of `available`, `up-to-date`, or `check-failed` in the AppShell.

**Not building:** another readiness capability, per-document token, presentation timer, native MessageBox substitute for ordinary check results, cache-backed install authorization, or a second release-comparison implementation.

### Behavior matrix

| Trigger | Discovery result | User-visible result | Side effect |
|---|---|---|---|
| automatic | newer eligible release | in-app `available` prompt | none until user chooses Download |
| automatic | no eligible release, including a skipped version | none | write normal check metadata only |
| automatic | fetch/refresh/parse failure | none | safe diagnostic log; the existing schedule remains armed for the next check |
| manual | newer release | in-app `available` prompt, ignoring the automatic skip preference | none until user chooses Download |
| manual | no newer release | in-app `up-to-date` prompt | none |
| manual | fetch/refresh/parse failure | in-app `check-failed` prompt with `https://github.com/zts212653/clowder-ai/releases` | none |

### Terminal prompt schema

```ts
type DesktopUpdatePromptPayload =
  | {
      kind: 'available';
      version: string;
      currentVersion: string;
      platform: 'windows' | 'macos';
      assetName: string;
      releaseUrl: string;
      releaseNotes: string;
    }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'check-failed'; version: string; releaseUrl: string }
  | {
      kind: 'ready-to-install';
      version: string;
      platform: 'windows' | 'macos';
      assetName: string;
    };
```

Action admission is closed by prompt kind: `available → download/later/skip/open-release`, `up-to-date → dismiss`, `check-failed → dismiss/open-release`, and `ready-to-install → install/later`. `version` remains the transaction binding for every kind. Main derives both release URLs and retains the selected asset tuple; renderer never supplies either.

### TDD implementation sequence

1. **RED — manager matrix:** add focused tests for all six automatic/manual outcomes, including conditional-refresh failure and manual override of `skippedVersion`.
2. **RED — durable prompt:** replace timeout/fallback assertions with pending-before-ready, ready-response replay, reload survival, current-main-frame rejection, and exact-once resolution tests.
3. **RED — renderer results:** add `up-to-date` and `check-failed` modal tests, canonical Releases action, dismiss/Escape behavior, and readiness-response hydration.
4. **GREEN — manager:** map discovery outcomes to the terminal schema and remove native check-result dialogs while leaving download/install recovery unchanged.
5. **GREEN — bridge/controller:** reduce readiness to one trusted-current-main-frame invoke that returns the pending payload; remove capability delivery and presentation timers.
6. **GREEN — startup:** gate BrowserWindow creation on an HTTP response from the packaged Web frontend rather than a TCP accept, so the first committed document is the current build.
7. **GREEN — renderer:** render all prompt kinds and hydrate the readiness response after subscriptions are installed.
8. **VERIFY:** focused RED→GREEN evidence, complete desktop/package suite, focused web suite, typecheck/lint/build, quality-gate, then a new exact-head Windows package acceptance covering automatic silence and all manual results.

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
2. Inject `showUpdatePrompt()` into `UpdateManager`; ordinary update-check results stay in the AppShell and remain pending across renderer reload instead of falling back to a native dialog.
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
4. Deny Electron-created windows. Hand remote HTTPS links and exact app/API/preview loopback-origin links to the system browser; reject other HTTP origins, unsafe schemes, and malformed URLs.

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
| renderer was ready, then navigation commits or its process exits | readiness resets; the pending result survives and is returned to the next trusted renderer |
| renderer opens `/uploads/...`, an explicit API-origin artifact, or a preview-gateway popup | Electron creates no child window; the exact app/API/preview loopback URL is handed to the system browser |
| popup URL uses a sibling loopback port, credentials-prefix spoof, remote HTTP, `file:`, or malformed syntax | denied without calling the system browser |

## Verification commands

```bash
node --test desktop/update-manager.test.js desktop/update-installer.test.js desktop/update-prompt-controller.test.js
pnpm --filter @cat-cafe/web test -- DesktopUpdatePrompt
pnpm --filter @cat-cafe/web typecheck
pnpm test
pnpm build
```
