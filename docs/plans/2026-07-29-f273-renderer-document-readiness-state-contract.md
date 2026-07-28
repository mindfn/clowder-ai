---
feature_ids: [F273]
topics: [desktop, electron, updater, renderer-readiness, state-machine]
doc_kind: implementation-plan
created: 2026-07-29
updated: 2026-07-29
---

# F273 renderer document-readiness state contract

> Stateful Object Gate contract by the F273 design owner (Fable), adopted for
> the PR #1227 stale-ready P2. This contract supersedes start-navigation
> admission-window proposals.

## Scope and release boundary

PR #1227 exact HEAD `b768d4e91f067f60d51b3055dbbaec5b6a2f88c9`
still admits a trusted `desktop-update:ready` sent by the old main-frame
document after readiness has been invalidated. The stale event can set
`_rendererReady` back to `true`, so a prompt created before the new AppShell
mounts does not arm the 15-second native-fallback timer.

Fork dry-run `0.12.0-rc.1105.3` (Actions run `30380555581`) is therefore
superseded and must not be offered for installation. A replacement RC can be
dispatched only from the repaired, exact-reviewed, CI-green PR head.

This plan changes no transfer owner, fallback duration, persistence, or React
API. `UpdatePromptController` remains the unique lifecycle owner.

## Why document identity is required

- `WebFrameMain` identifies a frame, not a document. Same-site navigation can
  reuse the frame and renderer process, so sender/main-frame equality plus
  origin validation cannot distinguish a queued old-document message from a
  new-document message.
- IPC and navigation events do not provide one cross-interface ordering
  guarantee on which an admission window can safely depend.
- `did-navigate` is the main-frame document commit boundary. A cancelled or
  failed provisional navigation has no commit and must not perturb the live
  document's readiness.

The selected mechanism is therefore a main-owned document token, revoked on
commit or renderer-process loss. `did-start-navigation` and its readiness
predicate are removed.

## Mechanism

1. Preload registers once per document through a trusted main-frame-only
   `desktop-update:register` invoke.
2. `UpdatePromptController` creates and returns a new opaque token. Preload
   stores it only in its isolated closure; React never receives or supplies it.
3. The existing zero-argument `bridge.updatePromptReady()` invokes
   `desktop-update:ready` with the closure token.
4. Ready returns `{ accepted: boolean }`. On rejection, preload performs
   exactly one REGISTER → READY retry, then stops. The existing native fallback
   remains the terminal safety path.
5. Main-frame `did-navigate` and `render-process-gone` revoke the token and call
   the existing pending-presentation invalidation behavior.

No new store or timer is added. The existing presentation timer remains the
only fallback timer.

## State × event transition table

State is `(documentToken, rendererReady)`:

- S0 = `(null, false)`: no authorized current document.
- S1(T) = `(T, false)`: current document registered but AppShell not ready.
- S2(T) = `(T, true)`: current document registered and AppShell ready.
- `(null, true)` is unreachable.

| Current | Event | Next | Required effects |
|---|---|---|---|
| S0 | trusted main-frame REGISTER | S1(T_new) | Generate and return a new main-owned token |
| S0 | READY(any) | S0 | Reject `{ accepted: false }` |
| S0 | commit / process-gone | S0 | Idempotent invalidation |
| S1(T) | READY(T) | S2(T) | Accept; invoke `onRendererReady` once; present/replay pending prompt and progress |
| S1(T) | READY(T' ≠ T) | S1(T) | Reject without presentation, replay, callback, or timer clear |
| S1(T) | REGISTER | S1(T_new) | Replace the token |
| S1(T) | commit / process-gone | S0 | Revoke token and invalidate pending presentation |
| S2(T) | READY(T) | S2(T) | Idempotently accept; do not start a second readiness epoch |
| S2(T) | READY(T' ≠ T) | S2(T) | Reject stale/forged token |
| S2(T) | REGISTER | S1(T_new) | Replace token and move in the safe, not-ready direction |
| S2(T) | commit / process-gone | S0 | Revoke token and invalidate pending presentation |

Negative lifecycle contract:

- `did-start-navigation`: no readiness mutation and no listener.
- Cancelled/fail-load provisional navigation: no commit, so no readiness
  mutation.
- Same-document navigation: no readiness mutation.
- Child-frame navigation: no readiness mutation.

### Ownership and bypass restrictions

- `UpdatePromptController` alone creates, replaces, compares, and revokes the
  token and alone writes renderer readiness.
- `desktop/main.js` forwards only main-frame `did-navigate` and
  `render-process-gone` invalidation events.
- Main code never reads or writes token/readiness fields directly.
- Preload cannot choose the token, exposes no token-bearing API to React, and
  retries a rejected ready handshake at most once.
- Renderer code keeps the existing zero-argument `updatePromptReady()` API.
- REGISTER and READY retain the existing current-window, trusted-origin,
  current-main-frame checks.
- No lifecycle caller may directly clear a presentation timer.

## Invariants and required tests

1. **INV-1 — Reachable-state shape.**
   `rendererReady` implies a non-null document token.
   - Test every transition in the decision table and assert no `(null, true)`
     state is observable through behavior.
2. **INV-2 — Bounded fallback.**
   A pending transaction whose current document is not ready has exactly one
   live presentation timer.
   - Test commit/process loss and repeated invalidation against timer
     identity/count.
3. **INV-3 — Commit revokes old documents.**
   After commit and before the next REGISTER, every READY is rejected.
   - Primary RED: accepted ready → commit → stale ready → `show()` must produce
     one live fallback timer.
4. **INV-4 — Commit/process loss re-arms pending presentation.**
   Both transitions leave ready false and re-arm the timer for an in-flight
   prompt.
   - Test while a pending prompt is presentation-ready.
5. **INV-5 — No-commit navigation is inert.**
   Cancelled, failed provisional, same-document, and child-frame navigation do
   not mutate readiness.
   - Source-contract test removes `did-start-navigation` readiness wiring and
     admits only `did-navigate` plus process loss.
6. **INV-6 — Token equality is mandatory.**
   READY with a random, old, missing, or malformed token is rejected.
   - Controller decision-table tests.
7. **INV-7 — REGISTER replaces authority.**
   Every REGISTER replaces the prior token; REGISTER from S2 moves to S1.
   - Test old token rejection followed by new-token acceptance.
8. **INV-8 — Retry is bounded.**
   A rejected ready causes exactly one preload REGISTER → READY retry; a second
   rejection stops.
   - Preload tests with controlled invoke results.
9. **INV-9 — Epoch callback idempotence.**
   Duplicate READY(T) in S2 never invokes `onRendererReady` twice.
   - Adapt the existing readiness-epoch test.

## Adversarial scenarios

| Scenario | Expected result | Evidence |
|---|---|---|
| ready → commit → queued stale ready → show | Stale token rejected; one fallback timer armed | INV-3 RED→GREEN |
| Old ready arrives after same-URL reload commit | Old token rejected | INV-3 / INV-6 |
| Old ready arrives between navigation start and commit | Old document may still be accepted; commit then revokes it and re-arms any pending fallback | INV-4 |
| Cancelled navigation | No commit; current readiness remains valid | INV-5 |
| Provisional load failure | No commit; current readiness remains valid | INV-5 |
| Error page commits | Token revoked; no preload registration means fallback remains available | INV-3 / INV-4 |
| Initial REGISTER is processed before initial commit | Commit revokes; READY rejection triggers one re-register/retry | INV-8 |
| Initial REGISTER is processed after initial commit | REGISTER then READY reaches S2 | normal handshake |
| Renderer crashes with queued IPC | Process loss revokes token; queued ready is rejected | INV-4 / INV-6 |
| Hash/history navigation | State unchanged | INV-5 |
| Preview iframe full navigation | State unchanged | INV-5 |
| REGISTER races while S2 | State moves safely to S1 with a new token | INV-7 |
| Forged or malformed token | Rejected | INV-6 |
| Duplicate READY for current token | Accepted idempotently; no duplicate schedule callback | INV-9 |
| Prompt is pending across commit | Timer re-armed; new document ready replays; transaction resolves once | INV-2 / INV-4 |
| Both ready attempts are rejected | Retry stops after the second attempt; native fallback remains reachable | INV-2 / INV-8 |

## Red → green implementation sequence

1. Add controller RED tests for INV-3, INV-4, INV-6, INV-7, and INV-9. Record
   the stale-ready failure on exact base `b768d4e91`.
2. Add preload RED tests for REGISTER → READY and the exactly-once retry rule.
3. Replace the overloaded boolean-only lifecycle with controller-owned token
   registration/revocation while reusing the current presentation timer and
   trust checks.
4. Replace preload's ready send with the isolated REGISTER → READY handshake;
   keep the renderer-facing method zero-argument.
5. Replace `did-start-navigation` readiness wiring with main-frame
   `did-navigate`; retain independent `render-process-gone` invalidation.
6. Run focused controller/preload/main tests, the complete desktop/package
   suite, Web TypeScript, targeted Biome, and `git diff --check`.
7. Update the F273 bug report and quality-gate evidence. Commit with a Why body,
   push, and request fresh exact-HEAD review from the P2 reviewer.
8. Only after local review, cloud review, and PR CI are green, dispatch the next
   Mac arm64/x64 and Windows Installer/portable RC from that exact SHA.

## Rejected alternatives

- **Start-navigation admission window:** depends on ordering between navigation
  and IPC delivery, needs cancellation/failure/redirect window repair, and
  still lacks document identity.
- **Renderer-generated token:** lets the untrusted side choose the asserted
  identity and gives main no independent authority to compare against.
- **Longer/reset timeout:** changes symptoms without preventing stale ready from
  suppressing fallback.
- **Renderer-owned readiness state:** duplicates the main-process lifecycle
  owner across the context-isolation boundary.
