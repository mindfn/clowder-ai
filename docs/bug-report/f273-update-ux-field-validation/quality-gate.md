---
feature_ids: [F273]
topics: [desktop, electron, updater, proxy, markdown, security, quality-gate]
doc_kind: quality-gate
created: 2026-07-28
tips_exempt:
  reason: Verification evidence for an existing desktop updater correction; it does not introduce a discoverable top-level Hub capability.
---

# F273 updater field correction — implementation quality gate

## Verdict

The repair slice is ready for cross-individual review. It corrects the two Windows field findings without weakening the existing release-asset identity, size, digest, resume, journal, or installer execution boundaries.

This report gates the implementation slice only. F273 remains `in-progress` until a reviewed exact-head v0.10.0 package is installed in the isolated Windows acceptance VM and exercises the v0.12.0 update path.

## Acceptance matrix

| Requirement | Implementation evidence | Test evidence | Result |
|---|---|---|---|
| Render release Markdown | `DesktopUpdatePrompt` renders the GitHub release body through the existing `MarkdownContent`; raw HTML is not enabled | heading/emphasis/raw-script component assertions | Met |
| Exact release link | Main derives `https://github.com/zts212653/clowder-ai/releases/tag/v{version}` after semantic-version validation; renderer can request only `open-release` for the pending version | manager, preload, component, and controller tests | Met |
| Browser-like system proxy path | Download remains on Electron `net.request` and receives `session.defaultSession` only for bounded `forceReloadProxyConfig()` / `resolveProxy()` diagnostics; no proxy override or environment injection is added | proxy success and best-effort failure tests | Met |
| Safe transport observability | Logs expose proxy decision, redirect host/status/method, response host/status, failure phase, and received bytes; every manager/controller error boundary redacts URL-bearing text, and signed redirect path/query are excluded | signed-redirect, upper-manager-error, controller-error, and connection-close phase/byte tests | Met |
| Manual recovery | Failed automatic download offers Retry, Download in Browser, and Cancel; browser action awaits the exact release page, reports opener failure with a canonical manual URL, and tells the user an overwrite install preserves data | manager failure-action and rejected-browser-opener tests | Met |
| IPC trust boundary | Main owns the pending payload and canonical URL; preload admits enumerated actions only; controller checks current main-window sender, main frame, exact version, and action, then resolves once | hostile sender/frame/version/action, replay, duplicate-action, and disposal tests | Met |
| Renderer-unavailable recovery | Initial prompt presentation is bounded; renderer navigation or process loss invalidates readiness and starts the same bounded presentation timer for a pending prompt; timeout falls back to a plain native dialog without raw Markdown | controller ready-then-unavailable, main lifecycle-wiring, presentation-timeout, and manager native-fallback tests | Met |
| Download-state recovery | Update-directory creation and download both run inside the `_downloading` ownership boundary, so either failure offers recovery and releases the lock | repeated directory-creation-failure test | Met |
| Packaged dependency closure | Electron build files contain every local JavaScript dependency reachable from `main.js` | recursive dependency-graph test first failed on both new modules, then passed | Met |

## Red-to-green record

1. Focused tests failed before the implementation for rendered notes, canonical link actions, IPC admission/replay, system-proxy diagnostics, safe redirect logging, phase/byte failures, and browser recovery.
2. The first full public suite found one additional packaging defect: `update-prompt-controller.js` was absent from `desktop.build.files`.
3. The packaging test was strengthened from direct `main.js` imports to the complete reachable local JavaScript dependency graph. Its red result identified both `update-prompt-controller.js` and the transitive `update-network-diagnostics.js`.
4. Both modules were added to the package manifest. The focused packaging test, all desktop tests, and the complete public suite then passed.
5. Fresh-context review reproduced four additional failures: an upper-layer signed-URL leak, a sticky `_downloading` lock after update-directory creation failed, an unhandled browser-opener rejection, and stale renderer readiness after reload or crash.
6. Four focused tests failed for those exact reasons before the correction. Error handling is now sanitized at each ownership boundary, directory creation is inside the existing `try/finally`, the browser recovery action is awaited and reports a canonical manual URL on failure, and Electron lifecycle events invalidate renderer readiness.
7. The same focused tests passed after the correction, followed by all 157 desktop tests and the complete public suite.

## Verification evidence

| Check | Result |
|---|---|
| `node --test desktop/*.test.js` | 157 passed, 0 failed |
| `node --test packages/api/test/build-script-cross-platform.test.js` | 8 passed, 0 failed |
| `pnpm --filter @cat-cafe/web test -- DesktopUpdatePrompt` | 6 passed, 0 failed |
| Adjacent AppShell tests | Passed |
| Web TypeScript check | Passed |
| Web production build | Passed |
| `pnpm lint` | Exit 0; existing warnings only |
| `pnpm check` | Exit 0; existing advisory warnings only |
| `pnpm -r --if-present run build` | Exit 0 |
| `git diff --check` | Passed |
| `pnpm check:capability-tips` | Passed |
| `env -u NODE_ENV -u REDIS_URL pnpm --filter @cat-cafe/api run test:public` | 16,690 passed, 0 failed, 28 skipped |

An isolated manager dogfood probe simulated a signed download error followed by a rejected default-browser launch. It produced:

```json
{"dialogTitles":["Download Failed","Could Not Open Browser"],"signedUrlRedacted":true,"manualUrlVisible":true}
```

The probe used a temporary directory and injected Electron mocks; it touched no runtime service, persistent store, reserved port, or real update directory.

The literal root `pnpm test` is not the public-sync truth source: this checkout intentionally omits private governance and operations artifacts that suite requires. `scripts/pre-merge-check.sh` selects `test:public` when `.claude/settings.json` is absent; the command above is the repository-defined suite for this upstream-main worktree.

## Security and failure-mode audit

- No renderer-supplied URL reaches `shell.openExternal`.
- No signed GitHub asset path, query, response header, token, or credential is logged.
- Proxy diagnostics are bounded and best-effort; failure cannot block the automatic request.
- Update-directory creation failure cannot strand the manager's `_downloading` lock.
- A rejected default-browser launch is awaited, sanitized, and converted into a visible canonical manual URL.
- Renderer navigation or process loss invalidates prompt readiness; every pending prompt still has a bounded native fallback.
- The manual browser path never authorizes local installer execution.
- Automatic execution still requires fresh GitHub metadata plus exact asset name, size, and SHA-256 digest.
- No local service, production Redis, persistent runtime store, or reserved port was used.
- No changed file adds three or more fallback layers. The presentation timer and browser-recovery helper each close one state-owner boundary; neither stacks alternate implementations.
- This public checkout does not contain `scripts/check-hotfix-pattern.mjs`, `scripts/check-fallback-layers.mjs`, or a `check:architecture-ownership` package command. Their absence is recorded rather than substituted with invented checks; the complete diff received a manual ownership/fallback audit.
- Architecture ownership remains `hub-action-surface` with no map delta: the correction adds no service, persistence owner, feed, or network boundary.
- Artifact-hygiene inspection found no generated root artifact or unexpected tracked build output.

## UI verification

The actual `DesktopUpdatePrompt` component was mounted through an isolated temporary Next.js route on port 3111, returned HTTP 200, and was opened in the in-app browser preview. The route was removed and the server stopped after inspection. No F273 design source exists in the repository (`docs/design/f190-console-layout.pen` is unrelated), so there is no matching `.pen` comparison target. The available preview tooling did not provide a screenshot capture artifact; DOM tests independently verify Markdown structure, HTML suppression, scrolling, link semantics, and every action.
