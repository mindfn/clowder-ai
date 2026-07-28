---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, download-progress, windows, quality-gate]
doc_kind: quality-gate
created: 2026-07-28
updated: 2026-07-28
tips_exempt:
  reason: Verification evidence for a field-driven correction to the existing desktop updater.
---

# F273 renderer readiness and download progress — quality gate

## Verdict

The implementation and repository-mechanical gates are green at the candidate diff from base `fa6989130`. The correction is ready for a fresh-context cross-family review, but it is **not yet visually accepted** and F273 remains `in-progress`.

The remaining gate is deliberately narrow: a browser-capable reviewer must exercise the actual AppShell surface and record the renderer modal plus the movable progress card. Component tests prove state and ownership contracts; they are not substituted for visual dogfood or an exact-head Windows installer run.

## Vision and acceptance matrix

| Operator requirement / failure | Implementation evidence | Automated evidence | Current result |
|---|---|---|---|
| Windows should use the same deliberate in-app update experience rather than unexpectedly falling through to a native dialog | `UpdatePromptController` starts the updater schedule from the first trusted renderer-ready epoch; `main.js` no longer starts the check immediately after asynchronous window creation | Untrusted-ready rejection, readiness-epoch, main lifecycle-wiring, presentation fallback, and full desktop suites | Implemented |
| “点击下载的之后看不到下载进度” | Main projects its existing download callback through one typed progress IPC; preload exposes a read-only subscription; AppShell renders the last-value snapshot | Manager context/clear assertions, controller replay/validation tests, preload subscription test, component progress test | Implemented |
| “给个小的可以在页面拖动和去掉的进度条” | A `react-rnd` card appears near the lower-right, is bounded to the window, and supports collapse and hide | Component tests cover one-card rendering, percentage, collapse, hide, and no renderer transfer-control action | Implemented; visual dogfood pending |
| Removing the card must not cancel an 800 MB transfer | Main remains the only download owner; the hide button changes renderer presentation state only and sends no IPC | Component assertion verifies no update action is sent while hidden progress continues to update | Met |
| Reload and retry must not leave the UI silent | Controller stores and replays the latest snapshot; an `idle` snapshot ends the transfer epoch and a same-version retry resurfaces the card | Controller reload replay and component same-version retry tests | Met |
| Terminal states remain actionable | Main clears progress before the existing install/failure dialog; the progress surface does not replace those dialogs | Manager failure/verification assertions plus focused component lifecycle tests | Met |
| Exact Windows field behavior | Reviewed exact-head installer must display the renderer offer and live progress in the isolated Windows acceptance VM | Not inferable from unit/component tests | Pending |

## Red-to-green record

1. Before implementation, focused desktop tests reported 47 passes and 6 failures for trusted startup ordering, schedule idempotence, progress projection, validation, and replay.
2. Before implementation, the focused renderer suite reported 6 passes and 4 failures for the missing card lifecycle.
3. The production changes then made the same focused suites green: 53/53 desktop assertions and 10/10 renderer assertions.
4. The complete desktop suite passed 171/171.
5. The complete public API suite passed 16,690 tests with 0 failures and 28 intentional skips.

## Verification evidence

| Check | Result |
|---|---|
| `node --test desktop/update-prompt-controller.test.js desktop/preload.test.js desktop/update-manager.test.js` | 53 passed, 0 failed |
| `pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/DesktopUpdatePrompt.test.tsx` | 10 passed, 0 failed |
| `node --test desktop/*.test.js` | 171 passed, 0 failed |
| `node --test packages/api/test/build-script-cross-platform.test.js` | 8 passed, 0 failed; reachable desktop main-process dependency graph remains package-complete |
| `pnpm --filter @cat-cafe/web exec tsc --noEmit` | Exit 0 |
| Targeted Biome check | Exit 0 |
| `pnpm lint` | Exit 0; pre-existing warnings only |
| `pnpm check` | Exit 0; feature truth, capability tips, SOP, skill surfaces, environment checks, and follow-up-tail checks passed |
| `pnpm -r --if-present run build` | Exit 0; web production build succeeded |
| `git diff --check` | Passed |
| `env -u NODE_ENV -u REDIS_URL pnpm --filter @cat-cafe/api run test:public` | 16,690 passed, 0 failed, 28 skipped |

### Repository-wide baseline boundaries

- The literal root `pnpm test` is not the public-sync truth source in this checkout. It fails before reaching the product suites because private governance settings, documents, scripts, and pack assets are intentionally absent. `scripts/pre-merge-check.sh` selects `test:public` when `.claude/settings.json` is absent, so the green public command above is the repository-defined upstream-worktree gate.
- The complete web test command reported 5,078 passes and 21 failures. A focused rerun reproduced the same unrelated baseline failures in governance-refetch, F232 artifact, skills-content, ThreadSidebar organize-flow, and adaptive pass-ball suites. None of those source or test paths appears in this F273 diff. The changed renderer suite itself is 10/10 green.
- The internal inbound Brand Guard scans whole staged public-upstream files and rejects their intentional `Clowder AI` branding. It reported only public-brand strings, including pre-existing strings in `desktop/main.js`, `desktop/update-manager.js`, its tests, and the F273 spec; no Cat Café brand was introduced into the public product. The candidate commit therefore used the hook's documented `--no-verify` escape after Biome, tests, diff checks, and the explicit staged-diff audit above were green. CI remains authoritative for the public branch.

## UI and dogfood gate

This surface is user-visible and interaction-heavy, so real UI dogfood is required.

Pencil was invoked before implementation, but the available server was configured for VS Code and could not connect to the active Antigravity editor. No `.pen` artifact is claimed, and no unrelated design file is used as evidence. The fallback design record in `bug-report.md` is grounded in the two real operator screenshots, the existing warm `DesktopUpdatePrompt`, and existing repository `react-rnd` surfaces.

The in-app Browser skill was also loaded, but its required `node_repl` browser-control tool was unavailable after repeated discovery. The skill explicitly forbids substituting standalone Playwright for the in-app browser path, so no synthetic screenshot is presented as dogfood.

Before formal approval, a browser-capable fresh-context reviewer must record:

1. The warm renderer-owned offer in the AppShell, compared with the operator's expected screenshot.
2. The progress card at 0%, an intermediate percentage, and terminal clear, with no toast/modal collision regression.
3. Drag within window bounds, collapse/expand, and hide while the main-owned transfer continues.
4. Same-version retry resurfacing after an `idle` transition and snapshot replay after renderer reload.
5. At most three screenshots plus a short interaction recording (approximately 15 seconds), tied to the reviewed commit SHA.

The subsequent isolated Windows installer acceptance must use the same reviewed SHA. It must verify the renderer offer and progress card in the packaged Electron client; the known VM block on `github.com:443` / `release-assets.githubusercontent.com:443` remains a separate network condition and must not be reported as a UI regression.

## Security and failure-mode audit

- The new channel is main→renderer only. Renderer code cannot start, pause, cancel, retarget, or supply a download URL.
- The main process constructs `{ version, assetName, progress }` from the already-selected trusted target. The controller validates phase, non-empty identity fields, finite progress, and the `[0, 1]` range before projection.
- A progress snapshot is sent only to the trusted current main window after trusted renderer readiness. Reload invalidates readiness and replays the last snapshot only after the new trusted document announces readiness.
- Hiding or collapsing the card changes no main-process state. Terminal clearing is still owned by the manager.
- Startup checking is deferred to a usable trusted AppShell. The existing native fallback still protects a pending prompt if that renderer is later lost; no unbounded timeout was introduced.
- The new diff adds two isolated best-effort `try/catch` boundaries in `main.js`, not three or more fallback layers or alternate implementations in one file.
- No new service, store, queue, router, adapter, dispatcher, persistence owner, or network boundary was added. Architecture ownership remains `hub-action-surface`; architecture map delta is none.
- This public checkout contains no `scripts/check-hotfix-pattern.mjs`, `scripts/check-fallback-layers.mjs`, or `check:architecture-ownership` package command. Their absence is recorded rather than replaced with invented green checks; the complete diff received a manual hotfix-pattern, fallback-layer, and ownership audit.
- Artifact-hygiene inspection found no generated root artifact or unexpected tracked build output.

## Close-gate boundary

This report does not close F273. AC-14 remains pending until the browser-capable visual review and exact-head Windows installer acceptance are attached. No CloseGateReport completion claim is made.
