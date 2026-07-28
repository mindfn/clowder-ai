---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, download-progress, windows]
doc_kind: bug-report
created: 2026-07-28
updated: 2026-07-29
tips_exempt:
  reason: Field correction for the existing desktop updater presentation and download-status path.
---

# F273 renderer readiness and in-app download progress

## Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | In the packaged Windows `0.12.0-rc.1105.2` client, the update offer appeared as Electron's native fallback instead of the existing renderer modal. After choosing Download, the application page exposed no download progress even though the taskbar/tray path can receive percentages. Expected: the platform-specific renderer offer appears during a healthy app startup, and an in-app surface shows the active transfer without making visibility control equivalent to cancellation. |
| **2. Evidence** | Operator screenshots captured both the actual native Windows dialog and the expected warm renderer modal. The installed dialog identifies current version `v0.12.0-rc.1105.2`; fork Actions run `30355177588` built that version from exact HEAD `fa6989130`, so this is not an old-package claim. `UpdatePromptController.show()` starts a 15-second timer whenever `_rendererReady` is false; expiry resolves `undefined`, and `UpdateManager._promptUpdate()` maps that result to the native dialog. Startup calls `updater.startSchedule()` immediately after `createMainWindow()`, while renderer readiness is emitted later from a React `useEffect`. Download progress currently terminates at `mainWindow.setProgressBar()` and tray tooltip mutation in `desktop/main.js`; no progress IPC exists in preload or the web bridge. The standard API-process preflight is not applicable to this remote packaged Electron observation; no claim about an unrefreshed local runtime is being made. |
| **3. Root cause** | **Prompt root cause:** startup update checking was scheduled immediately after `createMainWindow()`, which only starts asynchronous navigation. The check could reach `UpdatePromptController.show()` before the React-owned trusted-ready signal; its 15-second presentation deadline was measured from the check result rather than from renderer readiness. Expiry is the only valid-payload path that resolves without an action, and `UpdateManager._promptUpdate()` maps that result to the observed native dialog. The bug is the startup ordering contract, not Windows styling. **Progress root cause:** the main process never projected download status into renderer state, so the page could not render progress. |
| **4. Diagnosis strategy** | Trace the exact lifecycle `services.startAll()` → `createMainWindow()` → `startSchedule()` → `show()` → readiness IPC and characterize the race with a deterministic failing test. Compare it with the working hidden-window replay path. Separately trace `downloadAsset()` progress callbacks through `UpdateManager` and `main.js`, then specify one bounded, typed main→preload→renderer status projection before implementation. |
| **5. Timeout strategy** | If a deterministic startup-order test cannot distinguish a readiness race from an IPC-origin/preload failure, stop before implementation and add one safe lifecycle diagnostic at each boundary rather than increasing the timeout. Do not use live GitHub, production data, Redis `6099`, or reserved runtime ports for reproduction. |
| **6. Early warning** | A timeout-only increase, a second independent updater state machine in React, or making the close button abort the download means the design is treating symptoms. Three new fallback layers in one file trigger the Maine Coon coordinate-system audit. |
| **7. User-visible correction** | The automatic schedule begins on the first trusted renderer-ready epoch, so a healthy AppShell owns the offer; the existing bounded native fallback remains available if a pending prompt later loses its renderer. An app-local floating download card appears at the point of action, can be repositioned, collapsed, or hidden, and keeps the transfer alive when hidden. Terminal success or failure clears the card and retains the existing actionable dialog. |
| **8. Acceptance** | Red→green tests now cover startup ordering, one schedule per readiness epoch, typed main→preload→renderer progress, last-value replay after reload, hide-without-cancel, same-version retry resurfacing, ordinary-browser isolation, and the supported no-tray path continuing to project progress and terminal clear. Focused desktop/component suites, the complete desktop suite, Web TypeScript, targeted Biome, and `git diff --check` pass. Repository gate and exact-head visual/Windows package evidence are recorded separately; they are not inferred from component tests. |

## Reporter and reproduction record

- **Reporter:** operator, from a real Windows install of the RC package.
- **Operator requirement:** “Windows和mac的好像不太一样的？然后点击下载的之后看不到下载进度的；是不是可以给个小的可以在页面拖动和去掉的进度条这种之类的”
- **Actual:** native fallback offer followed by no app-visible download progress.
- **Expected:** renderer-owned platform offer followed by in-context progress.
- **Field package:** `ClowderAI-Setup-0.12.0-rc.1105.2.exe`, Actions artifact `8686889080`, exact source `fa6989130`.

## Field round 2: Windows identity, update preference, and color roles

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | After the Windows upgrade completed, the Windows 11 Toast attribution line showed `electron.app.Clowder AI` instead of `Clowder AI`. The operator also requested a default-on automatic-update switch under System Settings and identified that the update modal used the same teal status color for its link and primary action. |
| **2. Evidence** | The operator supplied a real Windows screenshot from the installed RC: the Toast body correctly says `Clowder AI Updated / Updated to v0.12.0`, while the OS-owned attribution line says `electron.app.Clowder AI`. `desktop/package.json` declares `build.appId: ai.clowderai.desktop`, but exact source `4e8aa1486` neither calls `app.setAppUserModelId()` nor writes `AppUserModelID` on the Inno-created Start Menu and desktop shortcuts. `update-checker.js` already defaults `autoCheck` to `true` and persists it, but no trusted renderer bridge or settings UI exposes it. The modal's primary button and release link both use `semantic-info`; the repository's operation/link roles are `console-button-primary` and `console-inline-link`. |
| **3. Root cause** | **Toast identity:** the application had a package identity value but never applied it to the running Windows process or the installer-created shortcuts, so Windows attributed the Toast to Electron's fallback identity. The title/body are not the cause. **Preference gap:** persistence existed without a user control plane, and `_scheduleStarted` prevented a stopped schedule from being restarted safely. **Color-role gap:** a semantic status token was used as a general interaction token. |
| **4. Diagnosis strategy** | Compare the packaged app ID, early main-process lifecycle, and both Inno shortcut declarations; require one exact AUMID across all three. Trace `autoCheck` from its persisted default through start/stop scheduling, trusted IPC, preload, and System Settings. Compare the modal classes against the repository's shared primary-button and inline-link CSS rather than selecting new colors locally. |
| **5. Timeout strategy** | If the shared AUMID still produces incorrect attribution in the next Windows package, inspect the installed `.lnk` property store and Toast activator registration on that VM before adding registry or notification-library workarounds. Do not guess or replace the working Electron notification body path. |
| **6. Early warning** | A hard-coded display name in the Toast body, renderer access to the settings JSON path, canceling an active download when auto-check is disabled, or adding a modal-only blue hex value means the fix is at the wrong layer. |
| **7. User-visible correction** | Windows Toast attribution is owned by the installed Clowder AI identity. System Settings exposes “自动检测更新”, default ON; OFF stops future automatic checks but leaves manual checking and any active transfer intact; ON checks immediately and restores the daily timer. Primary actions follow the selected theme, hyperlinks use the shared dark-blue link token, and download status retains its semantic color. |
| **8. Acceptance** | Red→green coverage requires process/shortcut AUMID equality, default/read/write/disable/re-enable schedule behavior, preservation of preference changes across in-flight checks and Skip prompts, trusted main-frame settings IPC, ordinary-browser isolation, modal focus containment/restoration, settings toggle success/failure, and CSS role assertions. Final Toast attribution remains a real Windows package acceptance item because macOS/component tests cannot prove Windows Shell identity resolution. |

The platform mechanism follows the upstream contracts: Electron requires a Windows Start Menu shortcut with an AppUserModelID for notifications, Microsoft requires explicit process/shortcut identity consistency, and Inno Setup supports `AppUserModelID` on `[Icons]` entries:

- <https://www.electronjs.org/docs/latest/tutorial/notifications>
- <https://learn.microsoft.com/en-us/windows/win32/shell/appids>
- <https://jrsoftware.org/is6help/topic_iconssection.htm>

### Design Gate: settings and interaction color roles

- **Existing System Settings language:** `SettingsSection`, `settings-resource-card`, and `SettingsResourceToggleSwitch` already define the warm card, text hierarchy, spacing, and theme-aware switch. The update preference extends this surface; it does not create a new settings dialect.
- **Primary action role:** `console-button-primary` maps to `--cafe-accent` / `--cafe-accent-hover` / `--cafe-accent-foreground`, so the download button follows the active theme.
- **Hyperlink role:** `console-inline-link` is the shared link class used by settings documentation links. Its foreground moves from the teal cross-post/status token to `--conn-blue-text` (light `#1d4ed8`, dark `#93c5fd`) with `--conn-blue-hover`.
- **Status role:** the progress dot, percentage, and bar continue using `semantic-info`; they communicate transfer state rather than an action.
- **Pencil boundary:** Pencil MCP was retried before this round's implementation and again failed to connect because the active server targets `vscode`, not Antigravity. No `.pen` artifact is claimed. The real modal screenshot, settings primitives, and repository tokens are the design truth sources.

```yaml
in_context_observability:
  primary_surface: "System Settings toggle for the persistent preference; Windows Toast for completed-upgrade attribution"
  why_not_dashboard_only: "The preference must be visible where users configure system behavior, while completion belongs at the OS notification point; a separate updater dashboard would hide both."
  deep_dive_surface: "main.log and the persisted update-settings.json remain diagnostic truth sources, not user control surfaces"
  noise_dedup_policy: "one persistent toggle state and one journal-backed completion Toast per successful upgrade; no notification is emitted for preference changes"
```

## Design Gate: contextual download progress

Pencil MCP was attempted before implementation, but the active server is configured for `vscode` and cannot connect to the required Antigravity editor. No `.pen` artifact is claimed. The fallback design record below uses the real field screenshots, the existing `DesktopUpdatePrompt`, and the repository's own draggable-surface primitives as the truth sources.

### Existing surface and style inventory

- `packages/web/src/components/AppShell.tsx` owns route-surviving root surfaces: activity rail/sidebar/content, the presentation float, concierge, and the desktop update prompt.
- `DesktopUpdatePrompt.tsx` establishes the updater's warm language: `bg-cafe-surface`, `border-cafe`, `rounded-2xl`, semantic-info accent, neutral text hierarchy, and modal z-index `120`.
- `PresentationFloatView.tsx` and `FloatingTranscriptWindow.tsx` establish the draggable-window language: `react-rnd`, `bounds="window"`, a dedicated move handle, warm surface/border/ring tokens, and explicit minimize/close controls.
- `ToastContainer.tsx` occupies bottom-right at z-index `50`; the concierge ball is movable at z-index `30`; presentation floats use z-index `35`; blocking update modal uses z-index `120`.
- The progress surface is a new status projection, not a second update action entry point. It coexists with taskbar/tray progress and the existing completion/failure dialogs.

### Proposed surface

- **Placement:** AppShell root so an active transfer survives route changes. Initial geometry is a compact `320px` card near the lower-right, offset above the default concierge ball; dragging is bounded to the viewport, and expansion or window resize re-clamps stale coordinates before paint.
- **Layering:** z-index `40`: above presentation/concierge floats, below transient toasts and blocking dialogs.
- **Visual language:** warm elevated cafe surface, subtle cafe border/ring, semantic-info status dot and fill, 12–14px text, 10–12px radius. No new hard-coded palette.
- **Content:** move handle + “Downloading update” + percent; selected asset name on one truncated line; one semantic-info progress track.
- **Controls:** collapse changes the card to a narrow draggable status pill; close means “hide this transfer” and sends no IPC. The accessible label states that downloading continues.
- **State ownership:** the main process remains the single transfer owner. Renderer receives a last-value status projection only; it cannot start, pause, cancel, or retarget a download.
- **Terminal behavior:** main emits `idle` after the transfer stage. The card clears, while the existing Ready to Install or Download Failed dialog remains the actionable terminal surface. A retry starts a fresh visible projection even for the same version.

### Placement trade-off

- **Selected:** lower-right with vertical offset. It is spatially consistent with transient progress/status, stays out of the activity rail and sidebar, and is draggable when it overlaps page content.
- **Rejected:** permanent header/status-bar entry. It would be less obtrusive but is not visible enough for a user who just initiated an 800 MB transfer, and it cannot satisfy the requested movable/removable behavior.
- **Collision policy:** toasts retain higher priority and may temporarily cover the card; the progress surface keeps its state and remains movable. The card does not attempt a new global overlay-layout manager.
- **Narrow fallback:** width is clamped to viewport minus `32px`; the desktop shell's current `900px` minimum normally keeps the full card viable. The collapsed pill remains usable without drag.

### State coverage

| State | Visible behavior |
|---|---|
| No active transfer / ordinary browser | No DOM and no update IPC activity. |
| Download start | Full card appears at `0%` (or the first resumed percentage). |
| Downloading | One card is updated in place; repeated progress events never stack notifications. |
| Collapsed | Draggable single-line pill retains version/percent. |
| Hidden | No card; transfer, taskbar, and tray progress continue. |
| Retry | A new start event resets hidden/collapsed presentation and resurfaces the card. |
| Verified / failed | Card clears; the existing actionable main-process dialog is shown. |
| Renderer reload | Current main-owned progress snapshot is replayed when the bridge subscribes again. |

```yaml
in_context_observability:
  primary_surface: "AppShell root draggable download-progress card"
  why_not_dashboard_only: "The user needs immediate feedback at the point where an 800 MB transfer was initiated; a separate dashboard would make healthy progress look like a stalled click."
  deep_dive_surface: "taskbar/tray for OS-level glanceability and main.log for after-the-fact diagnosis"
  noise_dedup_policy: "one last-value card per active transfer; progress replaces in place; user may collapse or hide it; terminal dialogs remain singular"
```

## Field round 3: initial reverse-tab containment

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | The update dialog receives initial focus, but pressing Shift+Tab before moving to a child control can move focus behind the modal instead of wrapping to its last admitted control. |
| **2. Evidence** | `containTabFocus()` treats `dialog.contains(dialog)` as an inside-dialog case, while the dialog's `tabIndex={-1}` deliberately excludes it from `getFocusableElements()`. The existing test covers last→first, first→last, external→first, and restoration, but not dialog→last. |
| **3. Root cause** | The containment decision distinguishes outside, first, and last focus, but omits the programmatically focused dialog container as an explicit boundary state. Native reverse traversal therefore remains unhandled for the first keystroke after opening. |
| **4. Diagnosis strategy** | Extend the existing focus-lifecycle test with one Shift+Tab event while the dialog owns initial focus. Require the last admitted control to receive focus, then make the smallest decision-table correction in `containTabFocus()`. |
| **5. Timeout strategy** | If the focused component test does not fail for this exact assertion, stop and inspect jsdom keyboard traversal semantics rather than changing production focus behavior without a deterministic reproducer. |
| **6. Early warning** | Adding another listener, querying a second focusable set, or moving focus ownership out of the existing effect means the correction is duplicating the focus state machine. |
| **7. User-visible correction** | Both Tab directions remain inside the blocking update dialog from the first keystroke after it opens. |
| **8. Acceptance** | The focused prompt test failed 1/13 on dialog→Shift+Tab before the fix and passed 13/13 afterward. The complete prompt/settings run passed 16/16 while retaining forward/reverse boundary wrapping, escaped-focus recovery, and close restoration. |

## Field round 4: frame-scoped renderer readiness

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | Loading an embedded preview frame can clear the AppShell readiness epoch even though the top-level document and its update listeners remain mounted. A later rendered prompt keeps its native-fallback timer and may fall through after 15 seconds. |
| **2. Evidence** | `main.js` listens to WebContents-wide `did-start-loading`, which has no frame identity. Electron 35.7.5 exposes `did-start-navigation` details with both `isMainFrame` and `isSameDocument`; the AppShell contains embedded preview navigation. |
| **3. Root cause** | Readiness belongs to the trusted top-level document, but invalidation is currently wired to an aggregate loading signal. The lifecycle owner therefore cannot distinguish AppShell replacement from subframe or same-document navigation. |
| **4. Diagnosis strategy** | Encode the document-boundary decision as a pure predicate, cover main-document, same-document, and child-frame cases, then wire only qualifying `did-start-navigation` events to `markRendererUnavailable()`. Preserve `render-process-gone` as the independent crash boundary. |
| **5. Timeout strategy** | If Electron 35.7.5 does not expose the documented navigation detail fields, stop rather than infer deprecated positional arguments. Verify the installed version's published type declaration first. |
| **6. Early warning** | Retaining `did-start-loading`, adding a compensating ready signal for iframe completion, or resetting the fallback timer would leave readiness attached to resource loading rather than document ownership. |
| **7. User-visible correction** | Embedded previews and in-page AppShell navigation no longer disturb update-prompt readiness; a real top-level document replacement still invalidates readiness until the trusted renderer registers again. |
| **8. Acceptance** | The focused desktop run failed 2/57 before the predicate and wiring existed, then passed 57/57. The complete boundary table admits only new main-frame documents; main-process wiring uses frame-qualified navigation, retains crash invalidation, and the complete desktop/package suite passes 187/187. |

## Field round 5: document-bound renderer readiness

### Bug diagnosis capsule

| Field | Current evidence and investigation boundary |
|---|---|
| **1. Symptom** | A main-document navigation can invalidate renderer readiness and then accept a queued `desktop-update:ready` from the old document. A prompt created before the new AppShell mounts sees readiness as true, arms no presentation fallback, and can wait indefinitely. |
| **2. Evidence** | PR #1227 exact HEAD `b768d4e91` reproduces the sequence trusted ready → `markRendererUnavailable()` → same old main-frame ready → `show()` with zero fallback timers. Sender WebContents, origin, and `WebFrameMain` equality authenticate the frame but do not identify the document occupying it. |
| **3. Root cause** | `_rendererReady` combines three distinct facts—document authority, AppShell readiness, and ready-message admission—without a document identity. Navigation invalidation therefore cannot distinguish the retired document's queued IPC from the replacement document's readiness. |
| **4. Diagnosis strategy** | Adopt the Stateful Object Gate contract in `docs/plans/2026-07-29-f273-renderer-document-readiness-state-contract.md`: main owns an opaque per-document token, commit/process loss revokes it, preload keeps it inside the isolated closure, and READY must match. First encode the stale-ready sequence as a failing controller test, then cover registration/retry in preload before implementation. |
| **5. Timeout strategy** | If token revocation does not make the exact stale-ready test fail then pass, stop and inspect the test's event ordering and token capture; do not add another navigation listener, retry loop, or longer timeout. |
| **6. Early warning** | Reintroducing `did-start-navigation` readiness mutation, exposing the token to React, letting renderer choose tokens, or adding a second fallback timer means the fix has left the document-identity coordinate system. |
| **7. User-visible correction** | A retired document can never suppress the bounded native fallback. Cancelled, failed provisional, same-document, and child-frame navigation leave the live AppShell ready; a committed replacement must complete a fresh trusted handshake before renderer presentation is considered ready. |
| **8. Acceptance** | The focused controller/preload test first failed in exactly two places: the old document started a second readiness epoch, and preload emitted no registration handshake. The document-token implementation then passed 65/65 focused controller/preload/main tests and 191/191 complete desktop/package tests. Web TypeScript, targeted Biome, `pnpm lint`, `pnpm check`, the workspace build, `git diff --check`, and an isolated production-controller lifecycle dogfood pass. Exact-head review/CI and a replacement package remain pending; `0.12.0-rc.1105.3` is superseded/do-not-install. |

### Design acceptance

- [x] Existing warm modal remains the healthy-renderer update offer on Windows and macOS.
- [x] Progress card uses repository tokens and existing `react-rnd` behavior.
- [x] Expanding a collapsed card or shrinking the window re-clamps its geometry so the full controls remain inside the viewport.
- [x] Closing/hiding the card emits no download action and does not alter `_downloading`.
- [x] Renderer reload replays active progress instead of waiting for the next byte.
- [x] Terminal success/failure remains actionable even when the progress card was hidden.
- [x] Component screenshot is compared against the existing warm modal and actual AppShell layering before review.
- [x] Automatic-update preference reuses the existing System Settings card and theme-aware toggle.
- [x] An in-flight check or Skip action cannot overwrite a newer automatic-update preference.
- [x] Primary update action follows the active cafe theme; shared hyperlinks use the dark-blue connector link role.
- [x] The blocking update prompt moves keyboard focus inside, traps Tab traversal, and restores the prior control on close.
- [ ] A package built from the corrected exact HEAD shows `Clowder AI` (not `electron.app.Clowder AI`) in Windows Toast attribution.

## Architecture ownership

- **Architecture cell:** `hub-action-surface`
- **Map delta:** none
- **Why:** this correction extends the existing desktop-updater projection into the existing AppShell surface. It adds no service, persistence owner, queue, router, adapter, dispatcher, or network boundary. Main remains the sole transfer owner; preload and React receive a read-only last-value snapshot.
