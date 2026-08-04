---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, download-progress, windows, quality-gate]
doc_kind: quality-gate
created: 2026-07-28
updated: 2026-08-04
tips_exempt:
  reason: Verification evidence for a field-driven correction to the existing desktop updater.
---

# F273 renderer readiness and download progress — quality gate

## Verdict

`0.12.0-rc.1105.7` is not the deliverable candidate. Its real Windows logs prove release discovery succeeds but packaged Web readiness is declared on TCP acceptance about 21 seconds before Next reports ready; the document-capability handshake is never accepted, and the 15-second presentation timer then selects the native fallback seen in the operator screenshot. That fallback necessarily drops the renderer release-note surface.

The current worktree implements the operator's straight-line contract: release discovery/comparison produces a typed result; automatic no-update/failure stays silent; every manual outcome renders in AppShell; a trusted readiness invoke returns any pending payload; and BrowserWindow creation waits for an HTTP response from packaged Web. Ordinary check results have no presentation timer or native fallback. Download/install recovery remains main-owned, including the existing native fallback for the separate verified-installer confirmation. The repository pre-merge gate is green on exact implementation SHA `196123a7eaf8d508826a78a3ea959750a8f470a7`; fresh cross-family review, cloud review, CI, a replacement exact-head package, and real Windows acceptance remain required before delivery.

## Vision and acceptance matrix

| Operator requirement / failure | Implementation evidence | Automated evidence | Current result |
|---|---|---|---|
| Windows should use the same deliberate in-app update experience rather than unexpectedly falling through to a native dialog | `UpdatePromptController` retains one typed pending result; the current trusted main frame receives it directly from `desktop-update:ready`. Navigation/process loss only marks the renderer unavailable; it never clears the result or starts a timer | Pending-before-ready, ready-before-prompt, reload replay, trusted sender/origin/frame, exact-once, and no token/timer/native-result-fallback tests | Implemented locally; replacement package pending |
| Manual and automatic checks must have different, predictable presentation rules | Manager maps discovery into `available`, `up-to-date`, or `check-failed`; automatic checks emit only `available`, while manual checks always emit one result and ignore automatic Skip suppression | Six-outcome manager matrix covers no update, failure, conditional-refresh failure, skipped version, and newer release | Implemented locally |
| Packaged startup must not race a half-ready Web document | ServiceManager now requires a 2xx/3xx HTTP response for Web while API/Redis retain their existing port/protocol gates | Bare TCP server is rejected; HTTP 200 server is accepted; production wiring asserts `_waitForHttpReady` | Implemented locally; packaged proof pending |
| “点击下载的之后看不到下载进度” | Main projects its existing download callback through one typed progress IPC; preload exposes a read-only subscription; AppShell renders the last-value snapshot | Manager context/clear assertions, controller replay/validation tests, preload subscription test, component progress test | Implemented |
| “给个小的可以在页面拖动和去掉的进度条” | A `react-rnd` card appears near the lower-right, is bounded to the window, and supports collapse and hide; expansion and window resize re-clamp stale geometry before paint | Component tests cover one-card rendering, percentage, collapse, hide, no renderer transfer-control action, and deterministic expansion/resize geometry | Implemented; visual dogfood recorded; exact Windows package pending |
| Removing the card must not cancel an 800 MB transfer | Main remains the only download owner; the hide button changes renderer presentation state only and sends no IPC | Component assertion verifies no update action is sent while hidden progress continues to update | Met |
| Reload and retry must not leave the UI silent | Controller stores and replays the latest snapshot; an `idle` snapshot ends the transfer epoch and a same-version retry resurfaces the card | Controller reload replay and component same-version retry tests | Met |
| Terminal states remain actionable | Main clears progress before the renderer install confirmation or existing failure dialog; renderer unavailability retains the native install fallback | Manager healthy-renderer/Later/fallback/verification assertions plus focused component lifecycle tests | Met locally; replacement package pending |
| Windows success Toast must not be attributed to `electron.app.Clowder AI` | The running process and both Inno-created shortcuts now share package app ID `ai.clowderai.desktop` | Regression test derives the ID from `desktop/package.json` and checks process plus shortcut declarations | Implemented; Windows package proof pending |
| Packaged Windows main process starts before any UI is created | AUMID is loaded from `app-identity.js`, which is included in `build.files`; runtime code never dereferences electron-builder-only `package.json.build` | Focused regression forbids the old dependency and checks runtime/package/installer identity equality | Focused RED→GREEN complete; fresh package proof pending |
| A trusted committed document cannot miss its only readiness capability | The commit transition owns create-and-first-deliver; top-level `dom-ready` only replays the current main-owned value. A rejected IPC invocation conditionally re-arms that same capability for a later event-driven attempt | Controller coverage requires one delivery at commit and the same value on replay; preload coverage requires same-token retry after invoke rejection and proves a retired rejection cannot clear the replacement marker | RED→GREEN complete; replacement package pending |
| Automatic update detection can be disabled, and defaults on | Existing persisted `autoCheck` is exposed through trusted main-frame-only IPC and a System Settings toggle; OFF stops future scheduling, ON checks immediately and restores the timer; in-flight checks and Skip actions merge the latest persisted preference | Manager lifecycle/concurrency, controller trust/validation, preload typing, and settings component tests | Met |
| Offer and active transfer use one theme identity; hyperlinks use a consistent dark-blue role | Eyebrow, selected package, progress dot, percentage, and fill use cafe-accent tokens; CTA uses `console-button-primary`; the version link retains shared `console-inline-link` / `--conn-blue-text` | Component/CSS assertions and targeted no-hardcoded-color checks | Met locally; replacement package pending |
| The offer contains the corresponding release-note content | Main forwards a trimmed, 32,000-character-bounded GitHub release body; the renderer uses a scrollable release-only Markdown surface with ordinary external links and no raw HTML, remote images, workspace links, mentions, or Mermaid behavior | Manager boundary assertions and renderer content/scroll/external-link tests | Met locally; replacement package pending |
| Ready to Install matches the warm in-app prompt when renderer is healthy | Prompt payloads are discriminated as `available` or `ready-to-install`; controller action allowlists are kind-specific; preload admits version-bound `install`; native dialog remains only the unavailable-renderer fallback | Controller rejects cross-kind actions; manager tests healthy install, Later, fallback, TOCTOU, journal, service, spawn, and quit paths; component test exercises the warm Windows action | Met locally; replacement package pending |
| The blocking update prompt contains keyboard interaction | Opening the prompt moves focus into its dialog; Tab and Shift+Tab remain inside it; closing restores the previously focused control | Component focus-lifecycle test covers initial focus, both wrap directions, external-focus recovery, and restoration | Met |
| Exact Windows field behavior | `.6` proved the complete updater flow; the replacement exact-head installer must additionally display release notes, active-theme progress, and the warm install confirmation in the isolated Windows acceptance VM | Not inferable from unit/component tests | `.6` functional flow accepted; Field round 9 visual delta pending |

## Red-to-green record

1. Renderer-readiness/progress correction: focused desktop tests first reported 47 passes and 6 failures; focused renderer tests reported 6 passes and 4 failures. The production change made them 53/53 and 10/10.
2. Windows identity/settings/color correction: focused desktop tests first reported 53 passes and 4 failures for missing app identity, bridge methods, trusted handlers, and schedule restart. Renderer tests failed for the missing settings component and the old color role.
3. The second production change made the focused desktop suites 57/57 and the prompt/settings renderer suites 14/14. A dedicated CSS assertion first failed on the old teal shared-link token, then passed on the dark-blue connection-link token.
4. Cloud review then exposed a trayless-path coupling: an early return in optional tooltip presentation suppressed the renderer projection below it. A new regression test failed 37/38 before the fix and passed 38/38 after tooltip handling became conditional without returning from the callback.
5. A subsequent cloud review exposed stale `react-rnd` geometry after the card height changes or the viewport shrinks. The focused renderer suite failed 1/12 before the geometry helper existed and passed 12/12 after a layout effect re-clamped on expansion and window resize.
6. Exact-head review then exposed two independent races: stale settings snapshots could restore `autoCheck: true`, and the nominally modal prompt did not own keyboard focus. The manager suite failed 2/40 and the prompt suite failed 1/13 before the fixes; they pass 40/40 and 13/13 after latest-on-disk merging and a complete modal focus lifecycle.
7. Cross-family exact-head review then found one narrow reverse-traversal edge: initial focus sits on the programmatically focusable dialog container, which is intentionally absent from the child focusable list. The prompt suite failed 1/13 when Shift+Tab was exercised from that initial state and passed 13/13 after the containment decision table routed dialog→last control.
8. Cloud exact-head review then exposed aggregate loading as the wrong readiness boundary: an embedded preview navigation could clear the still-mounted AppShell epoch. The focused desktop run failed 2/57 before the frame decision predicate and wiring existed, then passed 57/57 after only new main-frame documents invalidated readiness.
9. A later exact-head review exposed that frame identity still was not document identity: after invalidation, the old document's queued trusted ready could reopen readiness and suppress the fallback timer. The focused controller/preload run failed in exactly two places before the main-owned token handshake existed: the retired document started a second readiness epoch, and preload performed no REGISTER → READY handshake.
10. The first token handshake made renderer REGISTER the authority replacement operation. Focused controller/preload/main tests passed 65/65, but terra's fresh-context contract scan found the untested symmetric reordering: D1's queued REGISTER can arrive after D2 READY was accepted, replace D2's token, and demote the live renderer without any rejection available to trigger retry.
11. The R2 controller RED failed 1/20 at the expected assertion: duplicate D2 READY returned `{ accepted:false }` after delayed D1 REGISTER. Preload RED failed 2/8 because readiness intent still invoked REGISTER and no main-delivered capability path existed.
12. The corrected design deletes renderer REGISTER. Trusted main-frame commit is the only capability-mint/replacement edge; top-level `dom-ready` delivers it main→preload; persistent preload intent sends READY once per delivered capability. Focused controller/preload/main tests pass 67/67, including D1 late-register powerlessness, intent/capability both orders, duplicate delivery/intent, C1 rejection→C2 acceptance, dispose revocation, stale READY, and singular fallback timer.
13. The complete desktop and packaging-dependency suite passed 193/193.
14. The complete public API suite at the unchanged base candidate passed 16,690 tests with 0 failures and 28 intentional skips; this correction changes no API source.
15. Real Windows installation of `0.12.0-rc.1105.4` then failed during top-level main-process evaluation: packaged `main.js:13` dereferenced `require('./package.json').build.appId`, but the runtime package metadata has no `build` member. The candidate is superseded/do-not-install.
16. A new packaged-metadata regression failed 1/40 against the `.4` source, then passed 40/40 after moving AUMID ownership into explicitly packaged `app-identity.js` while retaining exact equality with electron-builder and Inno identities.
17. Real Windows installation of `.5` reached `Update available: v0.12.0` and then logged `Rendered update prompt did not become ready`. The new controller regression failed 1/21 because `markDocumentCommitted()` produced zero capability deliveries. It passed after trusted commit became the atomic create-and-first-deliver transition, with `dom-ready` retaining same-token replay.
18. Focused controller/preload/manager tests pass 68/68, and the complete desktop plus packaging-dependency suite passes 194/194.
19. Cloud exact-head review found that `signaledCapability` stayed set when `ipcRenderer.invoke()` rejected. The preload RED failed 1/9 because a later same-token replay remained suppressed. The fix clears the marker only if it still names the failed capability; a second race test proves a retired rejection cannot clear a replacement capability. Focused tests pass 70/70 and the complete desktop/package suite passes 196/196.
20. RC `.6` then passed exact-head review/CI, four-family artifact verification, and the operator's full Windows flow. The three real screenshots exposed the remaining presentation gaps. Field round 9 RED failed 8 desktop assertions and 3/14 prompt tests; GREEN passes 75/75 focused desktop tests and 14/14 prompt/progress tests. The complete desktop/package suite passes 201/201.
21. RC `.7` field evidence exposed the remaining presentation state machine as the wrong coordinate system. Field round 10 RED failed 17/69 focused desktop assertions and 3/17 prompt assertions. The straight-line manager/readiness/HTTP/UI implementation makes the same commands pass 69/69 and 17/17.

## Verification evidence

| Check | Result |
|---|---|
| `pnpm gate --no-rebase --skip-install` | Exact SHA `196123a7eaf8d508826a78a3ea959750a8f470a7`: exit 0; build, full `tsc --noEmit`, public tests, Web lint, and repository checks passed in 961 seconds |
| Public suite within the exact-SHA gate | 19,192 tests; 19,161 passed, 0 failed, 31 intentional skips; 813 seconds |
| `node --test desktop/update-manager.test.js desktop/update-prompt-controller.test.js desktop/preload.test.js desktop/service-manager.test.js` | Field round 10: 69 passed, 0 failed |
| `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/DesktopUpdatePrompt.test.tsx` | Field round 10: 17 passed, 0 failed |
| `node --test desktop/*.test.js packages/api/test/build-script-cross-platform.test.js` | Field round 10: 191 passed, 0 failed |
| `pnpm --filter @cat-cafe/web exec tsc --noEmit` | Field round 10: exit 0, including updated bridge mocks |
| `node --test desktop/update-manager.test.js` | 44 passed, 0 failed |
| `node --test desktop/update-manager.test.js desktop/update-prompt-controller.test.js desktop/preload.test.js` | 75 passed, 0 failed |
| Focused prompt Vitest suite | 14 passed, 0 failed |
| `node --test desktop/*.test.js packages/api/test/build-script-cross-platform.test.js` | 201 passed, 0 failed; reachable desktop main-process dependency graph remains package-complete |
| `pnpm --filter @cat-cafe/web exec tsc --noEmit` | Exit 0 |
| Targeted Biome check over all changed implementation/test files | Exit 0 |
| `pnpm lint` | Exit 0; pre-existing warnings only |
| `pnpm check` | Exit 0; feature truth, capability tips, SOP, skill surfaces, environment checks, and follow-up-tail checks passed |
| `pnpm -r --if-present run build` | Exit 0; web production build succeeded |
| `git diff --check` | Passed |
| Frontmatter check | The cloud P2 target and the new artifact README both pass; neither appears in the repository's nine known legacy omissions |
| Browser interaction | Settings toggle exercised ON → OFF → ON; computed link color `rgb(29, 78, 216)` equals `--conn-blue-text`, and primary background resolves from `--cafe-accent` |
| `env -u NODE_ENV -u REDIS_URL pnpm --filter @cat-cafe/api run test:public` at the unchanged API base candidate | 16,690 passed, 0 failed, 28 skipped |

### Repository-wide baseline boundaries

- The literal root `pnpm test` is not the public-sync truth source in this checkout. It fails before reaching the product suites because private governance settings, documents, scripts, and pack assets are intentionally absent. `scripts/pre-merge-check.sh` selects `test:public` when `.claude/settings.json` is absent, so the green public command above is the repository-defined upstream-worktree gate.
- The complete web test command retains the recorded 21 unrelated baseline failures in governance-refetch, F232 artifact, skills-content, ThreadSidebar organize-flow, and adaptive pass-ball suites. Field round 9 adds one passing prompt test and changes none of those source or test paths; the changed prompt suite is 14/14 green. This gate is recorded as baseline-red rather than misreported green.
- The internal inbound Brand Guard scans whole staged public-upstream files and rejects their intentional `Clowder AI` branding. It reported only public-brand strings, including pre-existing strings in `desktop/main.js`, `desktop/update-manager.js`, its tests, and the F273 spec; no Cat Café brand was introduced into the public product. The candidate commit therefore used the hook's documented `--no-verify` escape after Biome, tests, diff checks, and the explicit staged-diff audit above were green. CI remains authoritative for the public branch.

## UI and dogfood gate

This surface is user-visible and interaction-heavy, so real UI dogfood was performed.

Pencil was invoked before implementation, but the available server was configured for VS Code and could not connect to the active Antigravity editor. No `.pen` artifact is claimed, and no unrelated design file is used as evidence. The fallback design record in `bug-report.md` is grounded in the two real operator screenshots, the existing warm `DesktopUpdatePrompt`, and existing repository `react-rnd` surfaces.

The in-app Playwright browser ran the actual AppShell/settings code on isolated `127.0.0.1:4317`, backed only by a 404 mock API on `127.0.0.1:4318` and a narrow typed `desktopBridge`. Runtime ports and production Redis were excluded. Expected mock-API errors do not affect the exercised desktop surfaces.

The dogfood record covers:

1. Warm renderer offer, live progress at 0% and 42%, collapsed progress, and same-version retry resurfacing.
2. Current theme modal with a cafe-accent primary CTA and dark-blue shared release link.
3. System Settings automatic-check toggle exercised ON → OFF → ON, including a short interaction recording.

The selected review evidence is `f273-dogfood-03-progress-42pct.png`, `f273-dogfood-06-theme-modal.png`, `f273-dogfood-07-settings-auto-check.png`, and `f273-dogfood-settings-toggle.webm`. Other frames in the artifact directory are supporting lifecycle evidence rather than additional review attachments.

The later geometry correction is intentionally not presented as new browser dogfood: the in-app Browser skill's required Node REPL/browser-client tool was unavailable after two exact discovery attempts, and that workflow forbids substituting a standalone Playwright session. Its added evidence is deterministic red-to-green geometry coverage for both collapsed-to-expanded height growth and viewport shrink, plus the pre-paint/resize-listener implementation. The earlier visual evidence remains valid for the surface itself.

The final reverse-tab correction likewise has no visual delta. Browser control remained unavailable after the two exact discovery attempts required by the browser workflow, so no standalone browser driver is substituted. Deterministic DOM focus evidence covers the user-visible interaction: from initial dialog focus, Shift+Tab now selects the last admitted control; the same test retains both boundary wraps, escaped-focus recovery, and prior-focus restoration.

Field round 9 is a visual delta, but the browser skill's required browser-control entry point is not exposed in the current session. No standalone browser driver and no production-connected preview were substituted. The new evidence is the operator's three real `.6` Windows screenshots as the problem/design input; deterministic content, token, layout, action, fallback, and production-build checks; and an explicit requirement for new exact-head Windows screenshots before acceptance.

### Field round 10 dogfood

Scope verdict: required user-visible path, verified to the pre-package boundary.

The current React component was exercised through its real DOM event surface in the focused suite:

1. subscriptions install before `updatePromptReady()`; a pending `up-to-date` payload returned from that invoke hydrates the modal;
2. manual `up-to-date` renders the current version and “No update is required”; clicking OK sends version-bound `dismiss` and closes it;
3. manual `check-failed` renders “View Releases”; clicking it sends version-bound `open-release` without closing, then OK dismisses;
4. the existing `available` path still renders bounded release-note Markdown and the selected platform asset.

The Browser skill's required controlled-browser entry point is not exposed in this session, so no standalone Playwright substitute is presented as browser evidence. Exact packaged behavior is structurally post-build: the replacement Windows artifact must prove HTTP-gated startup, all three manual results, automatic silence, and release-note presentation from the reviewed SHA before field close.

The subsequent isolated Windows installer acceptance must use the same reviewed SHA. It must verify the renderer offer and progress card in the packaged Electron client; the known VM block on `github.com:443` / `release-assets.githubusercontent.com:443` remains a separate network condition and must not be reported as a UI regression.

### Document-readiness dogfood (historical round 6)

This correction changes a packaged Electron lifecycle rather than UI pixels, so
the pre-review slice dogfood used the production `UpdatePromptController` with
an isolated fake WebContents and real IPC handlers:

`commit+deliver C1 → replay C1 → READY(C1) → commit+deliver C2 → replay
C2 → stale READY(C1) → READY(C2) → show → Later`

The actual JSON result was:

```json
{"firstReady":{"accepted":true},"staleReady":{"accepted":false},"replacementReady":{"accepted":true},"legacyRegisterPresent":false,"timersAfterReplacementReady":0,"readinessEpochs":2,"promptReplayed":true,"resolvedAction":"later"}
```

This proves the repaired state path does not enter the former message black
hole. It does not replace exact-head packaged Electron or Windows Shell
acceptance.

## Security and failure-mode audit

- The progress channel is main→renderer only. Renderer code cannot start, pause, cancel, retarget, or supply a download URL.
- Prompt payloads are discriminated and action-authorized in main: `available` admits Download/Later/Skip/Open release, `up-to-date` admits Dismiss, `check-failed` admits Dismiss/Open release, and `ready-to-install` admits Install/Later. Preload exposes an enumerated, version-bound action sender; renderer never receives an installer path, digest, journal, service control, or spawn primitive.
- Release notes are main-owned data from the already-selected GitHub release, trimmed and bounded before IPC. The release-only Markdown renderer does not enable raw HTML, remote images, chat mentions, local file links, or Mermaid execution; external links remain subject to the existing HTTPS popup policy.
- The two preference invokes accept or return only `{ autoCheck: boolean }`, require the trusted current main frame and application origin, and expose no settings path or general persistence primitive.
- Check-result metadata and Skip actions reload the latest settings immediately before their synchronous write, so an `autoCheck` change made across either asynchronous boundary is preserved.
- Both external actions are main-owned exact URLs. `check-failed` accepts only `https://github.com/zts212653/clowder-ai/releases`; `available` accepts only the matching `/releases/tag/v${version}` path. Credentials, query strings, fragments, HTTP, and Releases-path lookalikes are rejected before presentation.
- The main process constructs `{ version, assetName, progress }` from the already-selected trusted target. The controller validates phase, non-empty identity fields, finite progress, and the `[0, 1]` range before projection.
- A progress snapshot is sent only to the trusted current main window after trusted renderer readiness. Reload invalidates readiness and replays the last snapshot only after the new trusted document announces readiness.
- Readiness is one trusted-current-main-frame invoke. Main validates the sender webContents, exact main frame, and application origin, marks the renderer ready, and returns the pending result or `null`. The AppShell subscribes before invoking, so a result is delivered either by the event path or the invoke response without a registration/token/capability ordering problem. Main navigation/process loss marks only renderer availability; the pending transaction survives.
- Hiding or collapsing the card changes no main-process state. Terminal clearing is still owned by the manager.
- Card geometry is re-clamped in a layout effect when its height changes and on every window resize, keeping the expanded controls within the current viewport without introducing persistence or another positioning owner.
- Tray tooltip presentation is optional: a missing tray no longer returns from the shared progress callback, so renderer progress and terminal clear remain projected in the supported no-tray fallback.
- Startup checking is deferred to a usable trusted AppShell, and packaged Web must answer HTTP before BrowserWindow is created. Ordinary check results remain pending if the renderer is lost and have no presentation timeout/native fallback; native dialogs remain confined to download/install recovery.
- The blocking renderer prompt owns focus while open: its dialog receives initial focus, the first forward or reverse traversal enters the admitted controls, both boundaries wrap, an externally moved focus is recovered on the next Tab, Escape remains a version-bound Later action, and cleanup restores a still-connected prior element.
- The settings component has two ordinary error boundaries: one for initial read and one for saving a toggle. No changed file adds three fallback layers or an alternate implementation path.
- No new service, store, queue, router, adapter, dispatcher, persistence owner, or network boundary was added. Architecture ownership remains `hub-action-surface`; architecture map delta is none.
- `scripts/check-hotfix-pattern.mjs` reports no hotfix pattern. The PR-wide fallback scanner triggers on historical accumulated branches across the long-lived F273 diff; Field round 10 is the coordinate-system correction, deleting the document-token/capability/timer/native-result-fallback layers rather than adding another one. `check:architecture-ownership` remains unavailable, so the explicit diff audit records no new Store/Queue/Router/Adapter/Dispatcher or ownership cell.
- Artifact-hygiene inspection found no generated root artifact or unexpected tracked build output.

## Close-gate boundary

This report does not close F273. The complete local gate is green on `196123a7eaf8d508826a78a3ea959750a8f470a7`; Field round 10 remains open until cross-family/cloud/CI gates and replacement exact-head Windows acceptance are attached. No CloseGateReport completion claim is made.
