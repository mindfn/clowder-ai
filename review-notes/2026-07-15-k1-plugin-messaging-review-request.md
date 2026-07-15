# Review Request: K-1 Plugin Messaging Domain Convergence

Review-Target-ID: `feat-k1-messaging-domain`
Branch: `feat/k1-messaging-domain`
Implementation candidate: `b850953ea`

## What

K-1 introduces the plugin-facing messaging domain as one complete kernel slice:

- `messaging.send(draft)` with canonical envelopes and host-issued addressing
- per-thread monotonic output events, durable subscription-local ack cursors, stale detection, and snapshot recovery
- atomic `messaging.appendElements` with provenance, revision, and ownership enforcement
- instance-scoped send/append settlement ledgers
- memory and Redis stores plus a K-2-facing `createMessagingDomain(...)` composition seam

The implementation candidate contains 13 commits and changes 39 files (`+5969/-19`) relative to `upstream/main@01bf27faf`. It does not migrate existing connector call sites or instantiate a broker; those belong to K-2/P-7.

## Why

The public plugin contract needs one reliable messaging model instead of exposing connector-specific transports. K-1 defines the host-owned boundary: plugins use scoped handles, while the existing connector transport retains platform delivery and degradation behavior. This keeps canonical identity, authorization, persistence, and replay semantics in the kernel without making plugins aware of raw thread IDs or connector internals.

## Original Requirements（必填）

> `MessageDraft.address: ThreadHandle | ConnectorBindingRef` — host-issued, no raw ID channel.
> `MessageEnvelope` is canonical and host-binds actor/audience/time.
> `MessageOutputEvent` has per-thread monotonic sequence for publish and append events.
> Ack is durable per consumer; stale cursors require snapshot recovery and never silently skip.
> Send key = `(pluginInstanceId, idempotencyKey)`; append key = `(pluginInstanceId, messageId, operationId)`.

- Source: `zts212653/clowder-ai-plugins@189f25d`, `docs/proposals/plugin-system-principles-and-v0-design.md` §3.1
- Operational scope/gate: `docs/proposals/v0-implementation-roadmap.md` PR-2 K-1
- Please judge whether the implementation preserves this host/plugin boundary and all five K-1 deliverables.

## Architecture Ownership（必填）

Architecture cell: `plugin-messaging`
Map delta: `new cell required`
Why: K-1 creates the plugin-facing messaging contract and reliability state machines. It is distinct from the existing connector transport cell (F088), which continues to own inbound/outbound platform transport and platform degradation.

Please check:

- whether `plugin-messaging` is the right ownership boundary or should be named/placed differently;
- whether the new ledger, event log, cursor, handle, and append-lock stores remain internal persistence seams of this cell rather than parallel transport infrastructure;
- whether additive `IMessageStore.extra.pluginMessage` persistence keeps `StoredMessage` as the single canonical message truth.

## Invariant Matrix

| Invariant | Required behavior | Main verification |
|---|---|---|
| INV-1 | Same send idempotency key returns the identical receipt | send, ledger, facade suites |
| INV-2 | Plugin drafts cannot produce `system` audience | validation + adversarial send suites |
| INV-3 | Sequence is strictly monotonic per thread | memory/Redis event-log suites |
| INV-4 | Unacked events redeliver; acked events do not | event-stream suites |
| INV-5 | Cursor token is opaque and subscription-local | event-stream adversarial cases |
| INV-6 | Append never rewrites an existing element | append suites |
| INV-7 | Append cannot wash `inference` into stronger provenance | append provenance cases |
| INV-8 | Cross-instance and revoked handles/messages fail closed | handle + append ownership suites |
| INV-9 | Retention overrun returns stale, never a silent gap | event-stream stale/snapshot suites |
| INV-10 | `baseRevision` conflict produces zero mutation | append CAS/lease-takeover cases |
| INV-11 | Existing non-plugin message paths remain unchanged | extra round-trip + rich-block regression suites |
| INV-12 | Repeated append operation never duplicates elements | append replay + Redis suites |

## Fresh-Context Findings Closed

All eight are fixed in implementation candidate `b850953ea`:

1. Trace fields were lost through persistence/projection.
2. Retention trim racing `read()` could silently skip events.
3. Snapshot head/message reads could include a message beyond the captured head.
4. An expired append-lock holder could overwrite a successor revision.
5. An old ledger claimant could release or settle a successor claim.
6. Redis `pluginMessage` parsing dropped fields and only shallowly validated values.
7. Replay after event trim could rewrite an event's original `baseRevision` from retry input.
8. Lock takeover after persistence but before emission could publish `rev3` before `rev2`; persisted `appendOps` now act as a small repairable outbox.

## Dogfood-Your-Slice

The official isolated Redis runner completed this 11-step plugin-developer path:

1. Issue a scoped thread handle.
2. Subscribe through that handle.
3. Send a plugin message.
4. Read the publish event.
5. Ack the delivered cursor.
6. Append derived elements.
7. Read the append event.
8. Take a consistent snapshot.
9. Replay send with the same idempotency key.
10. Replay append with the same operation ID.
11. Verify the final Hub-visible content projection.

Result: 11/11 pass. The temporary script was removed; no dogfood artifacts remain.

## Tradeoffs

1. **Contract mirror before v0.1 publish:** K-1 currently carries the candidate contract types locally so shape review can run in parallel with C-1. The five-step gate requires replacing/pinning this mirror to the exact published v0.1 package and running conformance before merge.
2. **Single-thread subscriptions:** each subscription binds exactly one ThreadHandle. Multiple threads require multiple subscriptions, structurally preventing a cursor from advancing across threads.
3. **Persistent append operation history:** `appendOps` records the original element IDs and `baseRevision`, enabling crash replay and predecessor-event repair. It is bounded by per-message append limits rather than silently compacted in K-1.
4. **Public-only stream/snapshot in v0:** whisper messages are send-only; authorized consumers may observe sequence gaps but cannot receive restricted content.

## Open Questions

### Technical OQ（for reviewer）

1. **Ownership cell:** should `plugin-messaging` become a new cell as proposed, with F088 retaining connector transport, or should the map express a parent/child relationship?
2. **Feature number collision:** this upstream-mirror branch uses tentative F258, while fork `develop_base` already uses F258 for Desktop In-App Update. Please choose the final upstream feature number; the implementation intentionally did not guess or rewrite history.
3. **Append outbox window:** `appendOps` repairs every committed predecessor before a successor write; event-key dedupe is retention-window bounded, so an old crash replay may re-emit the same `eventId` at a new sequence under the documented at-least-once contract. Please verify that this boundary and bounded, non-compacting operation history are acceptable for v0.1.

### Value OQ（for operator）

None. The remaining questions are reversible ownership/numbering/contract mechanics inside the approved K-1 scope.

## Next Action

Please perform a complete cross-family review of `upstream/main@01bf27faf...HEAD`, with particular focus on:

1. Redis Lua atomicity and owner-token protection for ledger, cursor, and append-lock transitions.
2. Event retention/read/snapshot race handling and stale recovery.
3. Append revision CAS plus `appendOps` repair ordering across lock expiry/crash windows.
4. Strict Redis `pluginMessage` parsing and coexistence with host-owned `extra` fields.
5. The architecture ownership and contract-mirror boundaries above.

This request is `review-ready`, not `shape-approved`. A reviewer pass is required before the latter signal is sent to the plugins thread.

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/feat-k1-messaging-domain/opus`
- Start Command: N/A — backend domain only; use the verification commands below
- Ports: N/A — no UI or runtime service is required

## Verification Evidence

| Check | Result |
|---|---|
| K-1 non-Redis targeted suites | 130/130 pass |
| Official isolated Redis targeted suites | 17/17 pass |
| Append lease-takeover regression | RED reproduced `op-2/rev3 -> op-1/rev2`; GREEN 21/21 |
| Dogfood real path | 11/11 pass |
| `pnpm check` | exit 0 |
| `pnpm lint` | exit 0; pre-existing web warnings only |
| `pnpm -r --if-present run build` | exit 0 |
| `git diff --check` | exit 0 |
| K-1 source/test file hard limit | all <=350 lines; maximum 341 |

Full `pnpm test` and full API `test:redis` still encounter upstream-mirror fork-only baseline failures. A branch/base comparison established identical failing sets before the final audit; neither run contains a K-1 failure. The focused Redis runner is green and uses isolated DB 15 on a non-reserved random port.

Related evidence: `docs/features/F258-plugin-messaging-domain.md` and the two bug reports under `docs/bug-report/`.

---

Date: 2026-07-15
Signed: [砚砚/GPT-5.6 Sol🐾]
