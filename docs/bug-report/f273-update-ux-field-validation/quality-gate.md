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
| Safe transport observability | Logs expose proxy decision, redirect host/status/method, response host/status, failure phase, and received bytes; URL-bearing error text is redacted and signed redirect path/query are excluded | signed-redirect redaction and connection-close phase/byte tests | Met |
| Manual recovery | Failed automatic download offers Retry, Download in Browser, and Cancel; browser action opens the exact release page and tells the user an overwrite install preserves data | manager failure-action test | Met |
| IPC trust boundary | Main owns the pending payload and canonical URL; preload admits enumerated actions only; controller checks current main-window sender, main frame, exact version, and action, then resolves once | hostile sender/frame/version/action, replay, duplicate-action, and disposal tests | Met |
| Renderer-unavailable recovery | Initial prompt presentation is bounded; if the renderer never becomes ready, the manager falls back to a plain native dialog without raw Markdown | controller presentation-timeout and manager native-fallback tests | Met |
| Packaged dependency closure | Electron build files contain every local JavaScript dependency reachable from `main.js` | recursive dependency-graph test first failed on both new modules, then passed | Met |

## Red-to-green record

1. Focused tests failed before the implementation for rendered notes, canonical link actions, IPC admission/replay, system-proxy diagnostics, safe redirect logging, phase/byte failures, and browser recovery.
2. The first full public suite found one additional packaging defect: `update-prompt-controller.js` was absent from `desktop.build.files`.
3. The packaging test was strengthened from direct `main.js` imports to the complete reachable local JavaScript dependency graph. Its red result identified both `update-prompt-controller.js` and the transitive `update-network-diagnostics.js`.
4. Both modules were added to the package manifest. The focused packaging test, all desktop tests, and the complete public suite then passed.

## Verification evidence

| Check | Result |
|---|---|
| `node --test desktop/*.test.js` | 153 passed, 0 failed |
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

The literal root `pnpm test` is not the public-sync truth source: this checkout intentionally omits private governance and operations artifacts that suite requires. `scripts/pre-merge-check.sh` selects `test:public` when `.claude/settings.json` is absent; the command above is the repository-defined suite for this upstream-main worktree.

## Security and failure-mode audit

- No renderer-supplied URL reaches `shell.openExternal`.
- No signed GitHub asset path, query, response header, token, or credential is logged.
- Proxy diagnostics are bounded and best-effort; failure cannot block the automatic request.
- The manual browser path never authorizes local installer execution.
- Automatic execution still requires fresh GitHub metadata plus exact asset name, size, and SHA-256 digest.
- No local service, production Redis, persistent runtime store, or reserved port was used.
- No changed file adds three or more fallback layers. The two user-facing fallbacks address distinct boundaries: renderer presentation failure and network download failure.

## UI verification

The actual `DesktopUpdatePrompt` component was mounted through an isolated temporary Next.js route on port 3111, returned HTTP 200, and was opened in the in-app browser preview. The route was removed and the server stopped after inspection. No F273 design source exists in the repository (`docs/design/f190-console-layout.pen` is unrelated), so there is no matching `.pen` comparison target. The available preview tooling did not provide a screenshot capture artifact; DOM tests independently verify Markdown structure, HTML suppression, scrolling, link semantics, and every action.
