---
feature_ids: [F179]
topics: [console, service-manifest, acceptance]
doc_kind: acceptance_table
created: 2026-04-30
---

# F179 Acceptance Table

> Scope reset after rebase: this table splits the feature into the two intended deliverables: Console full restructure and Service Manifest support. PR creation is not part of this thread.

## Dev Environment Contract

| Item | Value |
|---|---|
| Worktree | `/Users/lang/workspace/github-lab/clowder-ai-f170-phase-2a` |
| Branch | `feat/f170-phase-2a` |
| Start command | `pnpm dev:direct` from the worktree root |
| Runtime rule | Use the CVO-started worktree dev server. Do not restart services unless explicitly asked. |
| Port rule | Ports come from the worktree `.env`; do not assume public runtime ports. |
| Build rule | Do not run `pnpm build` while the dev server is serving this worktree. |

## Product Finish Line

F179 is complete when the old modal-centered console is no longer a user path, all console management flows are reachable through the route-based shell, and Service Manifest is the only net-new functional capability added beyond refactoring/polish.

## Not Building

- No new PR in this thread.
- No unrelated plugin marketplace or account/provider behavior changes unless required to preserve existing behavior in the new console shell.
- No standalone Service Manifest dashboard. Service status appears in the relevant console sections.
- No acceptance against stale screenshots, stale branches, or the closed PR state.

## Acceptance Items

| # | Deliverable | Source | Route/Trigger | Status | Evidence | Reviewer Verdict |
|---|-------------|--------|---------------|--------|----------|------------------|
| C1 | L1 navigation has exactly Chat, Signals, Memory, Settings as primary entries; Mission is not a fifth primary rail item. | F179 scope reset + Pencil rail | `/`, `/signals`, `/memory`, `/settings` | TODO | Current code still has Mission as a primary ActivityBar item. | BLOCKED until fixed |
| C2 | Old console modal path is removed as a user surface; `CatCafeHub` is not mounted from chat render paths after `/settings` becomes canonical. | F179 AC-1b | Chat view, split view | TODO | Current code still renders `CatCafeHub` from `ChatContainer`. | BLOCKED until fixed |
| C3 | Settings shell is the canonical console management surface with stable left navigation and right content area. | F179 AC-1b/1e | `/settings` | TODO | Need Playwright verification in current worktree. | - |
| C4 | Existing member management behavior is preserved in the settings route: list, add/edit member, owner/co-creator edit, availability toggle. | Existing behavior preservation | `/settings?section=members` | TODO | Need route-level UI verification + targeted tests. | - |
| C5 | Existing account/key behavior is preserved: built-in accounts are read-only where intended; non-built-in accounts remain editable/deletable through the new flow. | Existing behavior preservation | `/settings?section=accounts` | TODO | Need UI verification; "builtin/buildin" stale terminology must not drive acceptance. | - |
| C6 | Existing IM connector configuration behavior is preserved as independent platform cards with connection status and test action. | F179 AC-2c | `/settings?section=im` | TODO | Need UI/API verification. | - |
| C7 | Skill management is route-based and preserves installed skill browsing/preview without old nested-modal flow. | F179 AC-1e | `/settings?section=skills` | TODO | Need UI verification and tests. | - |
| C8 | MCP management is route-based, supports STDIO/HTTP edit forms, callback env read-only display, and existing enable/disable behavior. | F179 AC-1g/3e | `/settings?section=mcp` | TODO | Need UI verification and API security review. | - |
| C9 | Plugins/integrations page is a status/configuration surface only; it must not invent unsupported plugin functionality. | F179 scope reset | `/settings?section=plugins` | TODO | Need copy/status audit. | - |
| C10 | Signals, Memory, and Mission routes match the approved console shell/layout contract and do not rely on old Hub entry points. | F179 IA restructure | `/signals`, `/memory`, `/mission` | TODO | Need screen-by-screen Playwright verification. | - |
| C11 | F056 design-debt cleanup is complete for this feature surface: no raw hardcoded UI colors, no over-rounded cards, no nested cards/modals, stable text fit. | F056 + Pencil | Console pages and modals | TODO | Need lint/color gate + screenshot review. | - |
| C12 | Back/return/referrer behavior works when navigating from chat to route-based console pages and back. | F179 route compatibility | ActivityBar + route links | TODO | Need targeted tests + Playwright. | - |
| S1 | Service Manifest type and registry exist for known services: Whisper STT, MLX TTS, embedding, LLM postprocess, Playwright. | F179 Service Manifest | API module | TODO | Current code exists; needs review against final contract. | - |
| S2 | Read APIs return service list and live health without requiring owner privileges: `GET /api/services`, `GET /api/services/:id/health`. | F179 AC-3b | API | TODO | API build and related unit tests passed after rebase; needs route-level coverage confirmation. | - |
| S3 | Lifecycle APIs are owner-gated and bounded to registry scripts only: start, stop, install, logs. | Service Manifest security | API | TODO | Current code has owner checks; needs security review for command/path/port behavior. | - |
| S4 | Service status is shown inline in relevant sections, not as a standalone dashboard: voice, MCP/Playwright, ops/memory/system health. | F179 AC-3c/3d | `/settings` sections | TODO | Current `ServiceStatusPanel` exists; needs placement verification. | - |
| S5 | Voice companion visibility is tied to service availability and does not show optimistically before service health is known. | F179 AC-1d | Chat header / voice settings | TODO | Need hook/test verification. | - |
| S6 | Service Manifest errors degrade visibly and safely: stopped/unknown/error states are distinct; failed API calls do not false-green the UI. | Service Manifest UX | Settings service cards | TODO | Need UI/API tests. | - |
| S7 | Service logs and lifecycle operations never touch production Redis/storage and do not require runtime config modification. | Safety rules | API operations | TODO | Needs security review. | - |
| V1 | Full acceptance evidence is gathered from the current worktree only: targeted tests, Playwright screenshots, and current commit SHAs. | Scope reset | Review gate | TODO | No stale PR #576 evidence accepted. | - |

## Immediate Known Blockers

1. `ActivityBar` primary navigation currently includes Mission and not Settings.
2. `CatCafeHub` is still mounted from `ChatContainer`.
3. Several acceptance claims from the closed PR body are stale because the branch now has 397 changed files and a newer head.
