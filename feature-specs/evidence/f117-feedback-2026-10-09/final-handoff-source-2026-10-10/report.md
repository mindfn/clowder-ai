# Distinct final handoff after a callback — operator143/152/153

Accepted source/revision: `thread_msr51149hym0i79f#0001791604877657-000152-d70a0ecf` / `0001791604877657-000152-d70a0ecf`. Related operator153: `0001791604934659-000153-3ba6c6ac`. Reviewer P1 and previous UI approval: `0001791605056758-000160-068add86`.

## Observed failure and root cause

Astra independently inspected final response101 (`0001791604123156-000101-224c12c9`): its body included a legal line-start @astra, but History had mentions=[] and no dispatch receipt, with no remaining Queue work. Earlier callback123 (`0001791604430844-000123-29f6d684`) had delivered a different scope notification to Astra. The running source and dist matched.

routeSerial collected successful callback targets in a per-turn set and removed every matching target from the final response. This incorrectly treated two independent message sources as one source. Removing availability checks earlier did not address this separate mechanism.

## Final design

The callback message and the final lifecycle response each own their own source × target identity. Final response routing takes its own parsed body, without merging or subtracting callback targets. Existing Queue source identity/idempotency owns duplicate admission; no new cache, fallback, condition or inferred-text identity is added. A final response with identical text still has a distinct source ID; string equality cannot erase its delivery. A callback confirmation contributes its own persisted message ID once and never becomes a new final-message carrier.

Delete the per-turn recipient set, callback-to-final mention union/filter, and unused callback routing fields. Keep callback evidence for the existing turn-exit/custody guard and co-creator event ownership. Failed callbacks do not suppress a final handoff; plain final prose does not invent delivery from callback targets. Do not re-dispatch historical101/123.

Parallel route inspection found no corresponding target set/filter. Its existing contract suppresses ordinary final @ routing; explicit callback admission is independent. Keep that contract and add a regression for a confirmed callback followed by parallel final @ prose. This fix does not change parallel planning, permissions, provider behavior or Queue persistence schema.

## Red → green and affected checks

- Nine new real-source scenarios use actual MessageStore, InvocationQueue, lifecycle response admission and production commitCompletedResponseAndEnqueueA2ATargets. Before the change: 4 failures / 5 passes. Four failures precisely reproduce suppressed final mentions after a successful callback, including identical text and duplicate confirmation.
- All nine now pass. Assertions cover exact final source ID, completed lifecycle, production wake commit, independently queued source × target, no duplicated callback row and callback IDs recorded once. No recursive inline target execution.
- Five related API files: 156/156 (routeSerial callback/persistence, route strategies, parallel suppression, callback result parser, completed wake admission).
- Six boundary files: 52/52 (includes four parallel suppression tests, plus phase-H, verdict, callback custody, callback post-message and turn-custody telemetry). Parallel file overlaps the earlier run; these counts are not summed as unique tests.
- Author reran Astra's original independent reproducer against newly compiled feature dist: 1/1; both priorCallback=false and priorCallback=true retain codex. This rerun is author verification, not a new independent verdict.
- Feature API tsc succeeds; dist route-serial.js is newer than source. Biome succeeds with existing warnings; git diff --check succeeds.
- Tests use temporary test HOME, blocked Redis endpoint, in-memory stores and mocked provider streams. No runtime mutation, process restart or live provider invocation. No full gate/UI rerun for this API-only delta; prior UI review remains scoped to6a8.

## Review/publication continuity

- Cleanup/tips: approved4f04c36a4b99acf19a747b74bc3d687d501d4f9d/tree352e4d56f5254b1963861a3d9256ac064c9ea441, fact0001791604181900-000105-4a948a51.
- Error display: approved6a8f91618cf1a34a86536218b0f19d177d08c46c/tree63be5b317457d2f828c8846d703db4dd5ff4c78e, typed fact0001791605056758-000160-068add86. It explicitly does not approve this new routing delta.
- Next: exact-head independent review of this API delta, then authorized normal fast-forward of original#1398 source branch and a new fork develop_base incremental PR. No self-merge/restart. Do not reopen merged219 or claim operator soak complete.
- Known prior internal preparation delay and collaborative-content member-availability selector remain recorded separately; this handoff fix does not claim to resolve them. Operator121 conditional retry request stays excluded because no generic failed-response retry endpoint exists.
