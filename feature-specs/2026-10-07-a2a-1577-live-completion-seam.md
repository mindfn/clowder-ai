# C7 — Live per-source completion versus canonical delivery

Status: C7 boundary accepted by coordinator source579
`0001791352018236-000579-78f4a022`; coherent consumer migration in progress in
original task300. This is not code approval or a new implementation task.

Frozen fork HEAD `db3fbbce7b9b98fe5d6b34c44016d03075fb6f17`, public MERGE_HEAD
`3e70e1d6805be24672e8f841861f180d20b184c2`,102 unresolved index paths.
Accepted F202 input remains TREEe3efa166; successor material is separate.

## Actual seam, not a module-name deletion rule

Three source-map angles were read: frozen fork ADR-043 D2/D4/D6–D8; public
production factory/authority/repair/recovery call sites; public production-style
Live HTTP/MCP and missing-execution/mixed-source tests.

| Contract | Actual owner/path | Incompatibility |
| --- | --- | --- |
| Fork delivery | ADR-043 D2/D8; exact active child + LifecycleActiveRun adopts source into response History and retires only its Queue target | Reading proves delivery, not requested-work completion |
| Public Live completion | `DispatchAdoptionAuthority.run` explicit_source branch; `A2ADispatchDispositionService.completeAdopted` | Durable contiguous read then explicit completed/handled closes exact Ball source while Live child may continue |
| Public durable repair | `DispatchReceiptService.repair` converts Ball disposition into Message queueCustody targetOutcome and coordinator commit/prunes old carrier | Reintroduces retired Message pending/terminal owner and dual writes |
| Public restart | `queue-source-completion-policy.requiresDispatchDisposition`, RestartTargets/RestartWitness and CoordinationTerminalRetirement | A read explicit_source without disposition must not be inferred handled merely from child success or missing child |

Concrete anchors in the sole checkout:

- `DispatchAdoptionAuthority.ts:31–104`: ordinary gate is useful; actual proof
  still reads queueCustody bodyExposures/readEvidence. Its running child check
  does not compare returned execution.invocationId with requested invocationId.
  This is a port risk, not a tested/fixed security finding in this cut.
- `DispatchReceiptService.ts:62–174`: getByQueueExposure, Message custody outcomes,
  coordinator terminal commit, removed carrier projection and snapshot removal.
- `QueueReadEvidence.ts:57–119`: transitionQueueCustody witness writer/getter.
  There is no current production caller of its recordLiveFullReadEvidence.
- `index.ts:2605–2698`: public conflict side constructs receipts + adoption
  authority + Ball disposition + retirement scan. QueueProcessor repair hooks
  remain at486/2623 and2933; public startup/processor wiring also invokes repair.
- `f317-live-dispatch-adoption.test.mjs:23–205`: actual HTTP/MCP tests require
  unread completion rejected, full read still unhandled, explicit completion
  closes source exactly once, outer native turn/close revokes credentials.
- `f317-live-source-policy.test.mjs:114–155`: missing child cannot erase read
  source fence; mixed user/Agent carrier success cannot blanket-complete Agent
  source. The fixture itself uses removed merged/custody fields and needs porting.
- Public `CoordinationTerminalRetirement.ts` read from exact MERGE_HEAD: uses
  terminal.queueCustody.handledByCatIds to close reverse Ball handoff. It is
  absent on the fork tree; this absence is not evidence that public removed it.

Current callbacks and freshly built MCP intentionally omit the old complete-a2a
dispatch endpoint/tool. Existing native/full-body source consumers have already
been ported to canonical History; wiring only the public service back would
neither restore a real full-read witness nor solve the public completion contract.

## Evidence retained

Prior checkpoint VcFSMp completed2026-10-07T05:36:42.189Z,19 lanes exit0,
658/658,62 hashes unchanged, five old hold writers remain absent,102 conflicts.
Fourteen selected production files clean;15 format warnings retained. This
checkpoint did NOT cover the four old Live completion/repair consumers above.

Fresh selected semantic check (`31f9ef`) exited1: four actual source files,
33 diagnostics (missing queueCustody/transitionQueueCustody/getByQueueExposure,
removed carrier projections and old Queue snapshot/targetCats/userId APIs).
This is an actual integration/type failure, not a behavior RED/GREEN or proof
that the Live product journey is unusable. No assertions were deleted, fields
restored, or read-only progress predicates elevated into business authority.
The exploratory unmatched globs/missing file paths failed read-only; later
search used exact existing source paths. No runtime/service/data changes.

## Accepted boundary — source579, implementation in progress

Keep exact Live carrier admission/closing/drain and bodyless inbox; canonical
full-body adoption remains solely Queue→History delivery. Do not restore the
receipt/coordinator repair chain or map a Ball disposition into Queue terminal.

Separate requested-work completion from read and outer carrier success. If the
public per-source explicit completion remains required, it must attach to an
already-authorized exact business owner/attempt (Task/action), independent of
Queue delivery; no ordinary read may create that authority. Neither successful
carrier close nor missing child proves an uncompleted source handled. Do not
create an unapproved per-source response/Task protocol solely to satisfy old
fixtures, revive terminal work, or infer safe retry from failed/unknown execution.

The coordinator selected the first boundary. Old public fixtures requiring
full read to leave delivery pending until an untyped Ball disposition are an
explicit compatibility change, not a promise to restore that endpoint. Delivery
retires the exact Queue target into response History; it never closes an existing
business Task. No authorized typed owner means untyped completion is rejected
without writes. Typed wait/action/scheduled sources remain excluded from ordinary
read adoption. Normal exact response terminals and D10 failed edges remain owned
by their existing canonical writers; outer Live success cannot blanket-close work.

## Twenty-second cut — actual consumer and recovery evidence

Sole checkout and frozen identities remain unchanged,102 unresolved paths. The
Live callback guard now validates the returned child/parent/user/thread/target
and running status and requires the Host operation gate for explicit_source.
Actual HTTP and compiled MCP consumers share the same gate. Retired disposition
advertisement and QueueProcessor repair hooks were removed; only the affected
Live construction hunk in unmerged index was resolved, not the whole index.
Recovery visibility reads canonical published History plus viewer permission,
not old Message custody. Actual transcript and text writers now use MessageFrom.

Evidence directory `/tmp/sol-a2a-1577-c7-red-CEBkvq` retains all attempts:

- `live-http.log`:33 tests,25 pass/8 fail; actual child/gate/advertisement RED.
- `processor-red.log`:8 tests,6 pass/2 fail; old repair hooks and uncertain claim.
- `committed-reply-red.log`:1/1 failed, History committed but lost acknowledgement
  caused the exact target to be restored. This was a real product bug, not flake.
- `final-source-green.log`:69/69 after formatting, including actual Host
  Sessions/Call, HTTP/compiled MCP, processor, native credentials/transcript and
  recovery/summary privacy. It does not prove fresh final API dist or index.
- Append admission has the same lost-acknowledgement failure mode. Both paths now
  use one canonical recovery predicate: read actual source dispatch refs, reconcile
  exact claims, and leave claims untouched if History is unknown/missing. Only an
  exact persisted hand-over can trigger pre-provider compensation; provider calls
  remain zero in both Append lost-reply cases. No model or unknown tool retry.
- `append-reply-check.log` retains a new fixture failure (dispatcher binding
  returns a teardown function, not boolean); corrected `append-reply-green.log`
  passes both actual production cases. Older Live fixture/dist-path and MessageFrom
  failures remain in the directory; they are not suppressed by latest green.
- `final-format.log`:exit0,11 files,55 warnings retained. No unsafe fixes.

`/tmp/sol-a2a-1577-c7-check-J1pPvo` contains load-time behavior mutants for child
identity, closing/drain, and lost-ack recovery; original source hashes are compared.
Removing a guard must fail its behavior assertion, not merely module loading.
Expanded J1pPvo checkpoint completed2026-10-07T06:13:18.706Z:763/763 tests,
fresh shared/finance/MCP,19 production semantic diagnostics0,78 input hashes and
frozen identities unchanged. It is **failed**, because full format lane exited1
for inbox-test imports not sorted. Original results and logs preserved. Scoped
safe import sorting corrected it, inbox10/10 and full format exit0 (70 warnings).
Child/drain/lost-reply mutants all failed their expected behavioral assertion,
unchanged source hashes; not module-load failures.

Recovery-coordinate audit: the recovery helper replaces two rollback branches;
it is not a third authority fallback. Exceptions preserve uncertainty, not an
alternate owner. Body consumption and business completion remain distinct.
Historical33 type diagnostics in old authority/receipt/restart modules are
retained as original failures, not repaired by restoring old custody; remaining
restart consumers still need coherent migration. No final index/API/Web or
aggregate approval.
No runtime/config/user data changed, no Redis/shared data accessed or deleted.
Owned native credential teardown is ephemeral; fixture persistent data is retained.

F202 source590 reports independent advisory closure of feedback P2 on immutable
TREE70c79391, not formal approval. Accepted input is still e3efa166; the successor
chain and evidence must be consumed separately at the existing integration step.
SDK, final builds/pages/hooks/review/human/soak remain open.

## Twenty-third cut — retire the audited orphan Live writer chain

Actual imports, index/processor construction and each old writer/getter were
read. Five modules are now removed: DispatchAdoptionAuthority,
DispatchReceiptService, dispatch-receipt-publication, QueueReadEvidence,
live-dispatch-adoption. These form only the untyped completion/Message-custody
repair chain. The old getter reads its own custody-writer output, not a useful
canonical History projection. No active production import constructs them after
the C7 consumer port. This is a behavior/owner audit, not deletion by filename.
Live close/drain, process-local teardown and pure Ball classification are kept.

New retired-chain guard failed before removal (`retired-live-writer-red.log`),
then combined actual consumer suite87/87 (`retired-live-green.log`). The guard
also checks index construction and QueueProcessor hooks remain absent. Remaining
private optional port/type and restart custody consumers are explicitly pending;
older public untyped completion fixtures are not counted passed or deleted merely
to hide their load failures. Current canonical C7 matrix preserves their safety
properties, not obsolete permission representation.

All five source blobs remain recoverable from frozen public Git. No persistent
data was removed.102 conflicts unchanged at cut23. The full checkpoint at
`/tmp/sol-a2a-1577-c7-retired-check-EF0bKF` actually completed at
2026-10-07T06:20:14.370Z, returned by source600:20 lanes exit0,764/764 executions,
78 input hashes and10 absent writers unchanged,19 selected semantics0. Format
exit0 with70 warnings. Counts overlap HTTP/C7 and are not764 unique repository
scenarios. This does not replace final API/Web/index/Redis Message+Queue/pages/
review/human/soak. Original J1pPvo failure retained. Same F202 e3efa166 input.

## Twenty-fourth cut — old startup custody reconstruction retired

Actual imports, index order and old writer bodies were audited. Six DU modules
were deleted by the frozen fork and modified by public; their remaining callers
only form the obsolete startup/restart chain. StartupReconciler/MessageReconciler
and QueueEntry reconstruct pending work by Message custody CAS; RestartTargets/
Witness infer untyped completion, including legacy parent aggregates. StartupTypes
and the auto-added queue-source-completion-policy support only that chain. All
seven are removed, not because their names contain restart but because they
restore a second durable owner. Pure canonical projections and alive/unknown
child guards stay. Source blobs remain recoverable from frozen public Git; no
persistent storage removed. Six index conflicts resolved:102→96.

Canonical production already hydrates QueueLedger before listen, recovers exact
children after successful listen, settles their original responses through
settleResponseFromDraft, then reconciles parents. The actual Live tests now adopt
body, close/drain, run that child recovery/settlement, and hydrate a new Queue from
the same ledger. They cover running and succeeded outer children, settlement
outage and repeat recovery; delivered target never resurrects, undelivered sibling
remains pending, stale callback rejects, and business Task stays todo. Succeeded
child without final response content retains the existing interrupted-response
contract; outer success alone neither invents output nor completes business.

`/tmp/sol-a2a-1577-c7-startup-red-IdokA4/startup-owner-red.log`:4 cases,3 pass/1
absence-guard failure before removal. The3 canonical restart cases were already
green; not claimed as product RED. After removal/format, startup-owner-green.log
passes129/129 including actual Live, existing startup/liveness/Queue and response
settlement. A load-time startup-settlement mutant skips the production settlement
call and fails the expected processing-versus-interrupted response assertion;
child/drain/lost-reply mutants likewise fail behavior, unchanged5 source hashes.

Expanded fresh checkpoint actually completed2026-10-07T06:31:52.909Z, returned
by source606 at `/tmp/sol-a2a-1577-c7-restart-check-51eopY`:20 lanes exit0,
787/787 executions (HTTP/C7 overlap),82 fingerprints and17 absent guards unchanged,
22 selected production semantics0,96 frozen conflicts. Format73 warnings and
directory threshold warnings retained. It adds response
settlement and new real startup journeys to the existing source/HTTP/fresh MCP
regressions. Final index remains unresolved/uncompiled. Old public untyped
completion fixtures/private ports/governance and aggregate/F202/SDK gates remain.

## Twenty-fifth cut — private custody retry and direct trigger retired

Frozen fork commit3f126bba7b explicitly deletes the direct trigger after all
producers move to atomic Message+Queue. Public merge reintroduced it, with a
separate Invocation execution/Message custody initialize-transfer owner. Actual
imports/index construction and writer bodies were audited: remove that trigger,
QueuedMessageCustodyCoordinator, WaitContinuationRetryCommitter/Preflight and
queued-message-custody private port, plus orphan A2ADispatchDispositionService.
This is not removal of Task/action permission checks: canonical typed owner,
lease guard, QueueLedger and History paths stay. Coordinator's old helpers have
no surviving active producer after the direct trigger is removed. Pure canonical
observation is untouched. All six DU paths resolved96→90; blobs recoverable from
frozen public Git, no persistent data/config/runtime touched.

Index drops coordinator import/options and only the obsolete public direct-trigger
construction hunk. It keeps the persistedQueueDelivery holder, managed wake atomic
admission, exact-lease legacy adoption and independent post-commit notifier. Index
remains unresolved/uncompiled; no final production-composition approval.

`/tmp/sol-a2a-1577-private-port-red-VUE1z9/private-port-red.log` contains1 structural
guard failure before removal, not a fabricated product RED. After format,
private-port-green.log101/101 drives actual canonical connector/legacy lease/
notifier/exactly-once producer and C5/C6 owner rejection. A fifth load-time mutant
omits real notifier drain, and the production notifier test fails exactly its
broadcast-outage drain assertion; four existing mutants also fail real behavior.
Seven source/test hashes remain unchanged. Existing public untyped completion,
coordinator and direct-trigger fixtures remain pending semantic migration: they
are not dropped or counted green. This preserves safety obligations under C7,
not the retired old permission representation.

Fresh expanded21-lane checkpoint actually failed, returned by source612,
completed2026-10-07T06:41:13.758Z at
`/tmp/sol-a2a-1577-private-port-check-o7mWNp`:781 pass/1 whole-file load failure,
20 lanes exit0, deployment-callback exit1. Its29 passing cases do not cover the
unexecuted lifecycle file.88 inputs,23 absent guards and frozen90 conflicts
unchanged;25 selected production semantics0, format73 warnings. Original failure
logs retained. The production src/index import scan missed a **test** consumer:
f323-deployment-wait-lifecycle still imported removed WaitContinuationRetryPreflight.
Production absence is not complete consumer coverage. Remaining old fixtures/Redis guard/governance and
final API/Web/index/persistent Message+Queue/pages/hooks/review/human/soak still
open. Accepted F202 input remains e3efa166; no SDK authentication retry.

## Twenty-sixth cut — repair the overlooked C5 lifecycle test consumer

Keep the entire lifecycle file and all its existing assertions in the runner.
Its original authority assertion now uses retained DeploymentWaitStartGuard,
canonical Message/Task/private receipt and fresh deployment proof, not the removed
Message-custody retry preflight. Business Task stays blocked; repeat observation
keeps one transport. No production permission code changed or writer restored.

Thirteen added cases verify cross-scope/owner/missing-carrier zero-write rejection,
revoked private-store snapshots (receipt/subject/generation/fence/outcome/terminal/
current-child claim), and an actual Task owner transfer racing the proof read.
Snapshot fault injection is explicitly a guard test, not a new permission protocol.
Existing predicate freshness/pending recovery and stable attempt tests remain.
Formatted four-file C5 source checkpoint68/68 (original55 plus13) at
`/tmp/sol-a2a-1577-deployment-authority-fix-wgvhxL/deployment-fixed.log`.
Owner, generation and final re-read omission mutants each trigger1 expected
behavior assertion, not loading failure; five existing mutants also verified,
10 source/test hashes unchanged. These are mutation evidence, not a product RED.

New21-lane fresh checkpoint actually completed06:53:42.423Z, source618:
820/820 overlapping lane executions, every lane exit0;90 input hashes,
23 absent source guards and frozen90 conflicts unchanged.27 selected production
semantics0, fresh shared/finance/MCP, format74 warnings in56-file scope. All four
C5 consumers ran68/68 and eight mutants failed expected assertions, not load errors.
Old failure checkpoints are not overwritten.
Remaining old fixtures/governance/F202/SDK and final index/API/Web/Redis Message+
Queue/pages/hooks/review/human/soak remain open; no runtime/config/user data access.

## Twenty-seventh cut — orphan Redis custody Lua, retained Task authority

RedisTypedWaitCustodyGuard is an orphan restored by public merge: its old Message
custody Lua depends on already-retired TypedWaitCustodyGuard, with no production
caller after the canonical owner migration. Actual symbol scans include test
consumers: F323 Redis still imported it, yielding a whole-file load failure.
Remove only this code module (recoverable public Git), resolving90→89. Keep
RedisTaskStore/WATCH/private registration/continuation checks. Old typed Queue
custody tests remain pending, not green or claimed compatible.

F323 Redis's original4 cases stay, replacing helper witnesses with exact fresh
Task/private-receipt resolution, persistent outcome and coherent CAS winner
assertions. Foreign parent/source/thread/user/cat reject with unchanged raw Task.
Add2 controlled actual WATCH read-to-EXEC races for owner/generation: stale contender
returns null, winning raw hash unchanged, old private receipt revoked. No sleep.
Owned port0 Unix socket Redis helper ignores inherited REDIS_URL, retains every
key plus saved RDB/AOF/logs and stops only its own child. No cleanup/flush/runtime
Redis access. This does not prove complete Message+Queue atomicity or authorize
ordinary read to adopt typed sources.

`/tmp/sol-a2a-1577-redis-task-guard-bnZDWS`: pre-migration module-load failure
f323-redis-load-red.log plus structural orphan-guard-red.log retained, neither a
product RED. Initial14/14, expanded formatted91/91 (six real Redis cases, lifecycle,
typed registration and bridge guards). Exact-child and WATCH omission mutants
each fail1 behavior assertion on real Redis; retained8 also valid,14 source/test
hashes unchanged. Data directories are listed in each lane log and retained.

Fresh21-lane checkpoint completed 2026-10-07T07:05:33.356Z:827/827 execution counts
(overlapping lane scopes), no failures/skips/cancels/todo;94 unique inputs and frozen
HEAD/MERGE_HEAD/89 conflicts unchanged;24 absent guards true. Fresh shared/finance/MCP,
31 selected production semantic diagnostics0, format exit0 with77 warnings and directory
threshold warnings. Root readback on2026-10-08 verified every current input hash and
lane log plus10 expected behavior-mutant failures. Owned Redis saved at
`/tmp/a2a-deployment-task-sLwYlX`; mutant data at `-3v3Lcu` and `-fkjVR0`
(see exact mutant logs; all data retained). Remaining obsolete fixtures/governance/F202 successors,
final API/Web/index/full Redis Message+Queue/pages/hooks/review/human/soak/SDK stay
open. Accepted F202 stille3efa166; no merge/restart or runtime/config/user-data writes.

Managed command request rejected429 (3 holds/window), retryAt07:12:29.909Z,
command not started by that rejected request. Foreground handoff621 actually ran
the command successfully; astra response622 and sol624 later timed out. These are
failed delivery lifecycles, not failed command results or independent review approval.
No retry of the completed green checkpoint; original timeout/429/failures retained.
