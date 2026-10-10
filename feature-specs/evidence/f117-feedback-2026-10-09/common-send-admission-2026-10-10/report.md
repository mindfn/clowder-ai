# F117 common send admission — original task300 follow-up

Review base: `b4e86ad87256f5931f70c17da291778579f3d346`, tree `b150ac3e1ad1fd4d01dd44b10f55ba46f8696512`.
This packet covers the uncommitted successor of that base; its exact commit/tree is supplied in the review handoff. It does not claim approval or publication. Earlier `413efba0` changes_requested and `b4e86ad8` partial closure remain historical evidence, not approvals for this successor.

## Problem and resulting behavior

Different entrances still owned default strategy or progress: the user route materialized preferences, other producers omitted them, and several producers called `processNext` or `requestDrain` themselves. Thus the product default `next_work` waited for user messages but tried to append other sources. The earlier producer-busy patch and Queue tests did not establish the complete producer contract.

This implements the existing RFC, `docs/architecture/message-delivery-handling-handoff-audit.md` §2 and §5.1–5.2, rather than introducing a new architecture. Operator125 clarified admission timing; operator146/150 confirmed current external entrances, and operator156 identified the prior RFC obligation. Reviewer158 acknowledged the previous review coverage gap. Operator206 and reviewer208 require removal of replaced parallel paths, not merely another common helper alongside them.

The public atomic admission method is now `InvocationQueue.send`. After protocol parsing and authorization, entrances submit content, targets, sender, stable identity and optional explicit strategy. Common admission validates/resolves targets, chooses the single-message explicit strategy or thread > global > product preference, binds per-target existing `authorIntent`/exact parent, commits Message and Queue atomically, prepares domain authority/participants, then notifies one Queue drain owner. No source-kind scheduler, new per-cat preference, or new queue state was introduced.

The winning strategy is immutable on same-ID replay. Preferences changed later affect new messages; queued messages do not acquire a new default. The drain checks saved strategy and live target state/capability/owner/parent/Stop constraints. Idle targets start fresh; busy supported targets can append when requested; otherwise the durable Queue retains work. The prior same-target FIFO and cross-target native-ACK fixes are preserved.

## Current entrance wiring

| Entrance | Protocol / authority before send | Shared admission and progress |
| --- | --- | --- |
| User HTTP | `messagesRoutes`: identity, thread, bundle/whisper/Live constraints; parse explicit mentions/intent | `InvocationQueue.send`; no preference resolver, local append loop or processor dependency |
| Member callback / cross-post / multi-mention | Callback token or agent key, sender/thread/typed provenance, depth and ping-pong constraints | `appendA2ASourceWithLedgerAdmission` → `send`; existing-response completion uses the required atomic terminalization variant; common policy and wake |
| IM | `ConnectorRouter`: connector binding/permissions/command parsing and explicit mentions | `PersistedQueueDelivery.deliver` → `send`; no local last-active/default-member selection or busy-target scheduler |
| Mail / GitHub email intake | `deliverConnectorMessage`: authorized envelope with stable identity and optional target | `PersistedQueueDelivery` → `send`; missing target uses the common target resolver |
| GitHub Wait / persistent plugin notification | Producer's exact tracked subject, owner, target and continuation authority | `PersistedQueueDelivery` → `send`; progress receipts query/use the same Queue owner, never a producer append loop |
| Public targeted scheduler input | `createDeliverFn`: stable key, target and normalized authority | `PersistedQueueDelivery` → `send`; History-only notices and private payloads retain their distinct visibility contracts |
| Collective Channel / named Agent / private Work | Collective admission, origin echo, endpoint and standing Work permission checks | `CollectiveIngressDispatcher` / `CollectiveWorkDispatcher` → `send`; domain authority is prepared before the common wake |
| Owner reconsideration | Current authenticated source/grant/purpose checks | `send`; no route-owned `processNext`; recovery only recognizes durable rows / actual response evidence |
| Proposal child seed / meeting artifact | Existing proposal dispatch plan / destination ownership and exact artifact identity | `send`; existing seed adoption preserves its source identity; no producer-owned start step |
| Cloud bridge delivery retry | Exact original user source/target/attempt and recovery notice | `send` with explicit `next_work`; new retry source, no source mutation or general response-retry feature |

Target/intent parsing that represents an explicit user or protocol plan remains at its boundary. `send` validates an explicit target set without silently replacing it. Common fallback resolution is shared; producers do not select their own conversation default. No permission or owner check was removed to obtain delivery parity.

## Removed paths / required survivors

- Retired `appendAndEnqueueDurable` compatibility name; all production and test callers migrated to `send`, no production/test reference remains.
- User-route default preference lookup and materialization, including cloud retry's local intent builder. Removed unused `projectRoot`, processor, invocation-record and old turn-store compatibility dependencies from that route and its composition.
- Entrance-owned append/drain/start calls in ordinary messages, callback/multi-mention, Collective dispatch/reconsideration, proposal dispatch/reconcile and meeting dispatch. Their processor parameters/imports and corresponding test-route overrides were removed. Participant/authority callbacks are preparation, not a second scheduler.
- IM last-active/default-member fallback; IM no-target admission now uses the same conversation target resolver as other sends. Command/mention parsing still has its actual consumer and remains.
- Proposal auto-start warning branches and tests depending on them; project classification warnings remain valid. Tests observe the shared post-commit Queue notification instead.

`resolveMessageDispositionForAdmission` has one production consumer, common Queue admission. Queue manual Steer actions still bind an explicitly chosen intent; they are not ordinary producers. Private inputs, visible-notice/private atomic transactions, existing-response terminalization, and existing-source adoption retain their atomic APIs because their identities/visibility cannot be rewritten as a new public message. Startup recovery and typed action recovery can still ask the same drain to inspect already durable work. This is not a claim that all future entrances or every repository method have been replaced with a single HTTP endpoint.

The new callback preparation hook preserves the prior Work permission check before a runnable wake. On durable admission failure there is neither a consumed request ID nor a wake; a post-commit drain failure cannot undo the stored source. Same-ID retry uses the original row policy, including exact parent and fallback metadata.

## Author verification

All checks ran in this feature worktree with owned test fixtures. The API was compiled with `pnpm --dir packages/api exec tsc` (exit 0, `build.log.gz`). No runtime checkout or runtime config was written, and no provider was invoked.

| Check | Result | Artifact |
| --- | --- | --- |
| 82 API files, final compiled source | 1143 tests: 1141 passed, 2 intentional unavailable-Redis skips, 0 failures | `api-green.log.gz`, `api-files.json` |
| Live + persisted delivery, consistent dist-import copies | 35/35 | `typed-green.log.gz` |
| Collective producer / category / refusal / actual Queue seam | 30/30 | `collective-green.log.gz` |
| Reconsideration seam after producer cleanup | 12/12 | `reconsideration-green.log.gz` |
| All seven final consistent copies, regenerated from formatted sources (overlaps the above 35/30/12) | 77/77 | `all-copies-green.log.gz` |
| Reconsideration TS fixture through isolated Host/Service stores | 22/22 | `reconsideration-typed-green.log.gz` |
| Owned portless Redis concurrent/reload policy | 1/1 | `redis-green.log.gz` |
| Default-policy and FIFO/ACK reviewer counterexamples, adapted as below | 6/6 | `counterexamples-green.log.gz` |
| Biome changed source/tests at error level | 104 files, exit 0 | `format-green.log.gz` |

These groups are not added together as an independent reviewer total. The 82-file run already includes the new six-entrance test under both strategies, proposal and meeting regressions and cloud retry. Native dispatch/Queue ordering tests use controlled clients; Fastify uses inject, not a listening service. The reconsideration Host/Service tests use retained isolated fixtures, not the live service or a real model.

The retained Redis fixture directory for the final run is `/tmp/f117-send-policy-MnCzK6` (port 0 / Unix socket, AOF and RDB retained, no flush/delete). It confirms one winning source/row under concurrent retries and new defaults only for new identities; source TTL is -1.

### Red evidence and fixture corrections

Original review counterexamples remain intact: `/tmp/astra-b4e-default-policy.test.mjs` and `/tmp/astra-413-drain-boundaries.test.mjs`, with their original red logs. Final copies change the retired API name to `send`. FIFO/ACK fixtures additionally inject explicit guidance capability/context and establish the exact active parent before admission; assertions of FIFO and cross-target progress remain unchanged. This is **not** an unchanged rerun of the original script.

The initial reconsideration seam had a stale `handed` property and expected completed-but-unread input to block classification. That property is absent from the current run-level contract. The fixture now uses `runs[].inputReadSupported`, asserts the pending native receipt remains pending, and verifies completed work is recognized without recreation. Production read/settlement behavior was not changed for that correction.

Intermediate proposal failures came from an incorrect test-owner field and an assertion rejecting the still-valid unclassified-project warning. The first actual-entrance test used a non-UUID HTTP idempotency key and was corrected without changing request validation. Initial cloud-retry fixture expected the removed producer-local wake; its wake moved to Queue admission. Removing that fixture processor exposed the now-unused production dependency guard, which was removed together with the unused route option. Intermediate failures are retained separately and do not count as final greens. The first commit guard rejected formatting in raw evidence scripts; they are now compressed verbatim, with unchanged decompressed bytes, rather than reformatting the independent originals. Production code remains subject to the normal staged-file guard.

## Publication boundary / remaining responsibility

This packet is review-ready only. It does not inherit remote CI from `4fbb6a2c`, publish the current delta, merge #222, update the runtime or restart it. Fork #222's accepted plugin changes must be preserved when the approved F117 delta is overlaid; upstream #1398 must continue to exclude the separate CI/plugin migration scope. The original #1398/#222 delivery chain, later commit consolidation and operator-requested increment summary remain pending after review/publication. Internal preparation latency remains an observation; actual operator experience and soak are not automated acceptance evidence.
