---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, download-progress, windows]
doc_kind: bug-report
created: 2026-07-28
updated: 2026-07-28
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
| **8. Acceptance** | Red→green tests now cover startup ordering, one schedule per readiness epoch, typed main→preload→renderer progress, last-value replay after reload, hide-without-cancel, same-version retry resurfacing, and ordinary-browser isolation. Focused desktop/component suites, the complete desktop suite, Web TypeScript, targeted Biome, and `git diff --check` pass. Repository gate and exact-head visual/Windows package evidence are recorded separately; they are not inferred from component tests. |

## Reporter and reproduction record

- **Reporter:** operator, from a real Windows install of the RC package.
- **Operator requirement:** “Windows和mac的好像不太一样的？然后点击下载的之后看不到下载进度的；是不是可以给个小的可以在页面拖动和去掉的进度条这种之类的”
- **Actual:** native fallback offer followed by no app-visible download progress.
- **Expected:** renderer-owned platform offer followed by in-context progress.
- **Field package:** `ClowderAI-Setup-0.12.0-rc.1105.2.exe`, Actions artifact `8686889080`, exact source `fa6989130`.

## Design Gate: contextual download progress

Pencil MCP was attempted before implementation, but the active server is configured for `vscode` and cannot connect to the required Antigravity editor. No `.pen` artifact is claimed. The fallback design record below uses the real field screenshots, the existing `DesktopUpdatePrompt`, and the repository's own draggable-surface primitives as the truth sources.

### Existing surface and style inventory

- `packages/web/src/components/AppShell.tsx` owns route-surviving root surfaces: activity rail/sidebar/content, the presentation float, concierge, and the desktop update prompt.
- `DesktopUpdatePrompt.tsx` establishes the updater's warm language: `bg-cafe-surface`, `border-cafe`, `rounded-2xl`, semantic-info accent, neutral text hierarchy, and modal z-index `120`.
- `PresentationFloatView.tsx` and `FloatingTranscriptWindow.tsx` establish the draggable-window language: `react-rnd`, `bounds="window"`, a dedicated move handle, warm surface/border/ring tokens, and explicit minimize/close controls.
- `ToastContainer.tsx` occupies bottom-right at z-index `50`; the concierge ball is movable at z-index `30`; presentation floats use z-index `35`; blocking update modal uses z-index `120`.
- The progress surface is a new status projection, not a second update action entry point. It coexists with taskbar/tray progress and the existing completion/failure dialogs.

### Proposed surface

- **Placement:** AppShell root so an active transfer survives route changes. Initial geometry is a compact `320px` card near the lower-right, offset above the default concierge ball; dragging is bounded to the viewport.
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

### Design acceptance

- [x] Existing warm modal remains the healthy-renderer update offer on Windows and macOS.
- [x] Progress card uses repository tokens and existing `react-rnd` behavior.
- [x] Closing/hiding the card emits no download action and does not alter `_downloading`.
- [x] Renderer reload replays active progress instead of waiting for the next byte.
- [x] Terminal success/failure remains actionable even when the progress card was hidden.
- [ ] Component screenshot is compared against the existing warm modal and actual AppShell layering before review.

## Architecture ownership

- **Architecture cell:** `hub-action-surface`
- **Map delta:** none
- **Why:** this correction extends the existing desktop-updater projection into the existing AppShell surface. It adds no service, persistence owner, queue, router, adapter, dispatcher, or network boundary. Main remains the sole transfer owner; preload and React receive a read-only last-value snapshot.
