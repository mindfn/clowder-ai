---
title: A2A dev integration — frozen baselines and contract cuts
status: implementing
created: 2026-10-06
owner: cat-eqdvbcxw
reviewer: cat-xlbldqjc
---

# A2A dev integration: first contract cut

This is a working implementation record, not the shared roadmap or a completed
candidate. The merge is still open; dependencies are installed with lifecycle scripts
disabled and shared builds, but the complete workspace is not buildable yet.
No deployment, human acceptance or soak is claimed. Earlier checkpoints below
retain their original dependency/compiler failures rather than relabeling them.

## Authority, identity and frozen inputs

- Operator approval: `thread_msr51149hym0i79f#0001791275464837-000298-83464bf7`.
- Implementation handoff: same thread, `0001791275715108-000302-a72d7304`.
- Overall admitted task: `0001791275498653-000300-2a121472`, astra owns coordination.
  This work does not reopen G4 task194 or complete/mutate astra's overall task.
- Checkout: `/Users/lang/workspace/github-lab/cat-cafe-a2a-dev-1577`;
  `integration/a2a-dev-1577`, HEAD `db3fbbce7b9b98fe5d6b34c44016d03075fb6f17`.
- MERGE_HEAD: `3e70e1d6805be24672e8f841861f180d20b184c2`;
  merge base `5968c19ad8b334ba8497fbb722b3e908b0e135e1`.
- Canonical gh independently read [public #1577](https://github.com/zts212653/clowder-ai/pull/1577):
  MERGED, head `4b5944c4e3a864997ce7d20667151a1b9f96c00e`, merge SHA equals MERGE_HEAD;
  author `zts212653` (not a bot). Authenticated login `mindfn`, viewer permission WRITE.
  Source is an external public sync, not a PR originated by this thread. We adopt
  its v2/contract improvements by semantic port, not merge-as-is, and do not publish
  an author verdict or close any existing PR.
- Sol is the sole writer here; astra is the independent reviewer and roadmap writer.
  Operator `0001791431589436-000016-027ee9e2` supersedes the earlier full-F202
  prerequisite: this A2A candidate consumes only actual unified delivery/callback
  interface intersections. F202 registry, factory, Settings and package release
  remain independent. Public F202 candidate derivation remains in
  `thread_mu8dg6h7l2x4ohsk`, target astra. Its live worktree/plugin implementation
  are not a second write site, and this aggregate is not a public release branch.

## Conflict census

The following census and numbered checkpoints are historical. The current closure
authority is operator016 plus bounded scope correction025/027, and the plan at
`/Users/lang/workspace/github-lab/cat-cafe-develop-base/docs/plans/2026-10-08-f117-1398-delivery-closure.md`.
Do not infer current gates or restore reading phases from an earlier checkpoint.

Initial index: 180 unresolved files (127 UU, 2 AA, 51 DU). **DU is deleted by the
fork and modified by public**, not deleted upstream. QueueLedger is a fork-only
addition automatically retained; it is not a DU file. The stage census is in
`2026-10-06-a2a-1577-conflict-census.json`, with every remaining path and index kind.

| Contract group | Initial | Still unresolved | Why handled together |
|---|---:|---:|---|
| Queue / persistent stores | 22 | 10 | Pending source/target owner, claim, actual dispatch, replay and restart |
| Ball / wait contracts | 14 | 9 | Owner fences, wake provenance, explicit structured carriers |
| Read / context | 7 | 0 | readIntent, cursor selection, body exposure and exact-child adoption |
| Producer routes / providers | 32 | 10 | Source declarations, immutable launch fields, terminal propagation |
| API tests | 37 | 31 | Preserve behavior against the correct canonical owner, not retired helpers |
| MCP | 6 | 1 | Expose readIntent and quote/full drill contracts without inventing a new owner |
| Shared contracts | 3 | 0 | Queue receipt DTO / wait transport / exports, not a second ledger |
| Web | 47 | 47 | New shell plus pending-source / History response projection, append and scroll |
| Build / configuration | 7 | 1 | Dependency/lock and isolated launch changes; runtime config untouched |
| Ownership docs | 5 | 5 | Update owner map only after agreeing and testing actual consumer migration |

The count is not a progress percentage: a single index conflict can span a whole
owner migration. Automatically merged new consumers are also within the audit.

## Decisive contract cuts

### C1 — Keep one pending owner: QueueLedger → History dispatchRefs

Fork ADR-043 D1–D4 and D8 require one source row whose `targets[]` contains only
pending members, reversible claim, and History `dispatchRefs[]` for actual delivery.
Public `QueuedMessageCustodyCoordinator` still owns mutable Message custody and
public startup reconstructs Queue from it. The fork deliberately deleted that
family. Accepting its resurrected files/callers alongside fork hydrate would install
two competing recovery owners.

Implementation position: retain the fork ledger / lifecycle transactions as the
canonical path. Port required public features at existing owner boundaries; do not
restore Message custody as scheduling truth, dual-write receipts, or resurrect old
attempts. Caller census must include automatically added CarrierProjection,
RestartProjector and QueueReadEvidence modules, not only the 51 DU conflicts.

Actual anchors:

- `InvocationQueue.hydrateFromLedger` / `cacheLedgerEntries`, durable admission and
  `getDurableEntriesForMessages`;
- `index.ts` hydrates before startup; public introduces repair callbacks using
  `ballCustodyIngest.rebuild` (these callers were absent on the previous fork base,
  but genuinely exist in this new merge);
- public `StartupReconciler`: Queue custody reconciliation + orphan Message scan;
  fork: hydrated ledger scopes + no Message-custody reconstruction;
- `PersistedQueueDelivery`: fork atomic Message+ledger admission and private-input
  receipt versus public enqueue→Message custody→carrier admission fence.

Restart/rollback evidence must use fresh owned fixtures, preserve old inputs, and
never clear Redis/SQLite. No migration is considered proven by this source census.

### C2 — Ordinary returns remain obligation-free; structured carriers still win

Public explicitly accepts `producer_return` but leaves other ordinary declared
categories in legacy custody. Fork policy requires ci/review/conflict/issue/
continuation/a2a_failure to remain `queue_delivery`. This is a known policy delta,
not a reason to infer a carrier from prose.

Resolved wake/type conflicts keep both unstructured labels. Order remains
wait → action → user/scheduled/freshness → explicit a2a → producer_return → other
declared ordinary return → unknown legacy. The new label is transported by the
fork QueueLedger enum and validation; category fingerprints/hydration/replay are
still to be exercised. The actual dispatcher/delivery/replay conflicts remain open.

Tests now assert all six ordinary categories avoid a made-up carrier lookup and
producer_return cannot bypass an action fence. They are not yet executed because
the dependent workspace is still conflicted. Existing wait divergence and A2A
carrier-missing tests remain, rather than weakening the guard to get a green result.

### C3 — Integrate readIntent with exact-child adoption and quotes as one boundary

Keep public history/unread selection, cursor-scope validation and unread continuation
ordering; retain the fork's exact current-child + lifecycle + pending-target handoff.
Full queued bodies cannot become read merely by serialization. Sparse/cross-thread/
oversized reads must not retire a target, and the deferred unread tail must not
duplicate or skip execution-owned queued bodies.

`callbacks.ts` now combines public cursor logic with fork ledger/source adoption,
without Message-custody read acknowledgement. That mixed file is **not resolved**:
typed action/hold consumers and aggregate registration still need migration.
Trace HTTP schema → callback selection/adoption → MCP declarations/result contract
→ freshness/context consumers and execute both old/new persistence tests before
calling the new reading path compatible.

### C4 — Preserve failure propagation; reconcile a stale owner-map sentence

Fork ADR-043 D10 explicitly requires a failed A2A response to create an idempotent
queue-only `a2a_failure` edge referencing the canonical response, not copying it.
The fork dispatch map still says failure creates no predecessor Queue work. These
two local documents conflict. Treat D10 and the actual lifecycle writer as the
preservation baseline; reconcile that sentence during the ownership-map review.
This is not authorization to change `a2a_failure` behavior or close its recovery gate.

## Candidate disposition, not wholesale cherry-picks

| Candidate exact SHA | Decision | Evidence / remaining work |
|---|---|---|
| #210 `0c24872112df67856091379a9061674080cf09f4` | Port to new read contract | Public/fork anchor helper lacks structured quote/comment projection. Helper now equals this candidate byte-for-byte; HTTP/MCP full/oversized and unread consumer ports still pending. |
| #211 `02461bd58db0b6833920cddad7a3df327acb0f8e` | Retain / port | Current tokenizer before port equals candidate's pre-fix file; public still rescans js-tiktoken synchronously. Two source files and exact/responsiveness tests now equal the candidate; no route fixture/probe or private design text was blindly copied. Integrated dependency/build and long-text tests still pending. |
| #212 `143b3f5341a24a8ba219f4ef508fbb81688173cd` | Public capability covered; no duplicate implementation | Public apply awaits store.save and returns reducer.accepted; ingest rebuild/record/recordFenced share subject chain. Public repair callers really use ingest. Preserve public reducer improvements, add/reuse rejection/save failure/order regressions after installation; no claim of full behavioral equivalence or passing integration tests yet. |
| #213 `54c1d5a424ade5005adec82c3214588d073a5227` | Partial public overlap; semantic port | Real dispatcher already declares producer_return. Ledger schema/validation and ordinary policy preserved here; public/live immutable-category retry checks from the candidate still needed in the ledger delivery path. No relabeling of old unclassified rows and no terminal replay resurrection. |
| #214 `45bbac3175a014b9d8121f687476e270fa6533a5` | Port build transaction to new launcher | Public start-dev has no build-identity writer; runtime-worktree stamps are a different entrypoint. Retain public named-alpha/data isolation and artifact verification additions. Transplant transaction at the normal build seam, not the complete old script; failure/partial/quick/source mutation/signal-descendant and strict resolver tests still pending. |

All old PRs stay open. The table records source findings and partial ports, not
independent approval of the integrated candidate or a change to human/soak gates.

## First-stage evidence and next gate

- Quote probe runs the **actual** pure TypeScript helper with Node strip-types,
  no replacement helper/services/Redis: 2/2 RED (missing comment projection), then
  2/2 GREEN after the reviewed #210 helper port. Raw output is preserved in
  `2026-10-06-a2a-1577-early-evidence.json`.
- First inline probe was blocked by `protected_target_unparsed` before execution;
  it is a tooling failure, not a RED or product finding. A named test file resolved
  the parser issue without relaxing runtime sanctuary.
- Scoped diff whitespace and three JavaScript test syntax checks passed. This
  is not TypeScript build, HTTP/MCP, Redis, UI, or complete candidate verification.
- At the first-stage cut, only two index conflicts were resolved and 178 remained. No merge commit/push of
  an incomplete candidate, no dependency installation or service launch occurred.

Architecture cut C1–C4 and the preservation/port matrix were independently
accepted in `0001791276719258-000308-98d286f8`. This is not code approval or
completion of task300. Implementation continues in this same tree.
Resolve queue/recovery/producer and read/MCP consumers as coherent cuts,
integrate Web and #214, resolve dependencies, and build all four packages afresh.
Full risk-matched regressions, owned persistent old/new fixtures and actual isolated
page journeys are required before exact integrated SHA is submitted for code review.
F202 has now supplied its frozen tree; semantic consumption is recorded below,
not a wholesale patch application or aggregate approval.

Runtime, configuration, user data and the closed Needs Me sample remain untouched.

## Second-stage implementation checkpoint

- Normal build transaction from exact #214 has been ported at `build_packages`,
  retaining the public launcher, named-alpha coordinates, isolated Redis paths
  and runtime artifact proof. The build owner joins its own POSIX compiler group;
  no service launcher/main was executed. Web's existing shared revision helper
  already accepts the pinned revision and was not replaced.
- The production-success seam was observed RED: old retained API stamp did not
  match the fixture's HEAD. Initial port also exposed four swallowed compiler
  failures (returned 0 instead of 17); explicit failure propagation fixed that.
  33/34 fixture regressions passed; the remaining real TypeScript probe failed
  because this checkout has no installed compiler yet, not a product RED. Keep
  this attempt and rerun the complete test after installing dependencies.
  A separately selected rerun excluding that unavailable compiler probe passed
  33/33; this does not turn the retained 34-test attempt into a full pass.
- Shared queue/wait conflicts are reconciled: retain opencode plus public
  google/agy vocabulary, strict explicit guidance declarations, shared bounded
  wait domains, and fork suppressed/queue_conflict outbox states. A GitHub
  publish claim remains a separate optional field, never a terminal delivery
  state that could strand an unsent wake after rollback.
- Dependency conflict selects the public Claude SDK 0.3.285 and its lockfile
  records, preserving every nonconflicting fork dependency and test command.
  This is adoption of the frozen sync, not a claim of SDK behavior acceptance.
- `PersistedQueueDelivery`'s conflict hunks retain atomic ledger admission and
  target-only private receipt paths, without restoring Message-custody admission.
  The #213 immutable-category checks and integrated persistence tests are still
  pending. Resolving that file is not evidence that its full migration passed.
- Test-home conflict initially selected public behavior and was tested without
  making network connections. Two REDs exposed the fixed shared 6398 binding,
  inherited runtime paths and overwriting an explicitly isolated URL. The merged
  wrapper now denies unowned Redis with `127.0.0.1:0`, strips inherited paths and
  preserves explicitly declared isolated stores: 2/2 GREEN. No Redis was opened.
- Ten more index conflicts resolved; 168 remain. No integrated buildable candidate
  yet. A same-checkout dependency install with lifecycle scripts disabled is the
  next bounded prerequisite; native lifecycle/build preparation remains separate.
- Source-only merged freshness capability checks passed 2/2, including strict
  rejection of unknown vocabulary and missing explicit append capability. These
  do not prove provider append behavior or authorize a custody transfer.

## Third-stage consumer checkpoint (after interruption/resume)

- HEAD and MERGE_HEAD remain the frozen values above. Ten additional index
  conflicts are resolved; **158 remain**. A failed staging invocation used an
  incorrect path for active-execution-service and changed no index entries;
  the corrected exact paths were staged successfully. No merge commit exists.
- Managed install completed successfully with `--ignore-scripts`; its overall
  command failed because shared compilation lacked the public bubble-pipeline
  definitions and routing projection helper. Pure public types/helper were
  reconciled without restoring scheduling custody; subsequent fresh shared build
  passed. Complete API/MCP/Web compilation and native preparation remain pending.
  The full #214 build-identity fixture subsequently passed 34/34 with the real
  installed compiler; this is not the integration's real four-package handshake.
- Queue keeps the fork admission/claim/retirement kernel and gains a disposable,
  content-free source-change notification only after canonical cache commit.
  A failed listener cannot roll back durable admission, private rows do not
  advertise public bodies, and idempotent unchanged rows do not manufacture events.
- Public Collective execution scope is ported as a **restriction, never a grant**:
  ledger codec/admission/replay preserve unknown owner provenance and immutable
  scope. The atomic Message/Queue store validates the matching durable sender,
  exact public participation target/receipt or private Work invocation receipt.
  Invalid scope/source admissions roll back their ledger rows, leaving no source.
  Source tests observed four missing-source/target/receipt REDs and a separate
  sender mismatch RED before correction. Two connector mismatches were already
  rejected by MessageFrom validation, not newly discovered vulnerabilities.
- Real Collective Work and ingress writers use the atomic ledger path; Work
  writes unknown `collective-work` scope instead of strict owner provenance.
  Public work-acceptance/execution notices and revision resume branches remain.
  The actual Work writer's two source tests verify one source on retry and a
  fresh domain-authority recheck, using a deterministic context port; public
  service grants/provider execution are not claimed by these tests.
- Ordinary body selection **and direct reversible claim** exclude scheduled,
  wait, action and scoped domain owners. Actual Queue/codec tests preserve
  producer_return readability, sibling targets, claim rollback, History-committed
  restart and immutable retired private receipts. HTTP/MCP exact ActiveRun
  permission fences remain to be integrated and exercised at their consumers.
- Automatically added Live inbox remains a read-only projection. Its stale
  Message.queueCustody dependency returned no candidate for real ledger work
  (4/4 source REDs). It now joins pending QueueLedger with canonical History
  refs and exact response lineage, including terminal delivery failure without
  inventing a model-read witness. No pending owner, body or metadata receipt
  shadow is written. Missing notification/playback evidence stays unknown/false.
  Its 10 source regressions verify read/unread, sibling retirement, terminal
  failure and rejection of cross-owner/thread/cat/input/entry evidence.
- Context formatting keeps canonical MessageFrom identities and managed-hold
  visibility, plus public served-model attribution and untrusted Collective Host
  receipt presentation. Redis parser ports preserve public native companion,
  content modification and delegation metadata without Message custody writes.
  These parser changes still require their integrated persistence regressions.
- Five new source-seam files pass **39/39** (Queue/codec 12, immutable producer
  category 6, atomic Message scope 9, Live inbox 10, real Work writer 2).
  `consumer-evidence.json` retains available raw failure evidence, including the
  corrected test-API harness mistake; it does not convert harness errors to RED.
  #211's two actual source files were freshly compiled alone in this checkout;
  its exact-count and long-Chinese responsiveness regressions pass **8/8**.
  This scoped utility compilation writes no build revision stamp and is not an
  API build. No services, Redis processes, model calls or browser were started.

### F202 frozen input, not a second write site

Received source315/321/322 from `thread_mu8dg6h7l2x4ohsk`:
tree `e3efa1666bfbff9a92dfdbfc521675041fc5a39c`, not a commit; author HEAD
`5c129e3db555415e87fd97c1cdd6c3e11a92940f`, common public base is MERGE_HEAD.
Evidence directory: `/Users/lang/workspace/github-lab/f202-acceptance/host-v2-1577-2026-10-06`.
This writer rechecked the tree object's existence and both patch SHA256 values:
public candidate `8a9aecf8814e548cfce9b5686195490bda13394a83fddca79aacd3f77adb4afd`,
unstaged delta `5b646b24f50d60f696baad4f27b48695fa46dc911390192cc32c4a250db18b0f`.
The 495-file public-to-candidate delta is **not applied as a package**. The
read-only advisory is tied to that tree, not a commit approval or a substitute
for final integrated build/review. Preserve C1 module/cloud attribution, public
desktop readiness/pre-submit failure/terminal recovery and Manager/height/
nonsecret-complete-value/secret-mask fixes as their shared seams are resolved.
No F202 worktree files are edited here. Its Brand Guard failure remains a real
source constraint: final candidate must pass target hooks normally, with no
hook bypass, blanket exemption or tree-as-approved-commit claim.

Next coherent cut: QueueProcessor and routing/provider scope consumers, then
HTTP/MCP history/unread/exact-child adoption, canonical restart projections and
Web. #212 repair callers and D10 failed-route seam still require integrated
tests. Finish semantic F202 consumption before fresh full builds, owned Redis
fixtures and browser journeys; submit only a real exact candidate SHA for review.

The post-format checkpoint in `/tmp/sol-a2a-1577-consumer-check-ZSbHUB` completed:
8 lanes exit 0, **87/87** tests. This is fresh shared plus scoped source/utility/
fixture verification, not complete API/MCP/Web build.

### Fourth cut: real QueueProcessor and route/provider consumers

Thirteen further indexed conflicts are resolved, **145 remain**. Frozen HEAD and
MERGE_HEAD are unchanged; no commit, running service or runtime configuration
change. Parseable/resolved files are not a completed semantic integration.

- QueueProcessor keeps exact claimed ledger ownership and History receiver truth.
  Scope reaches both normal/remedial serial children and parallel children.
  Public early/late deployment readiness guards and Collective pre-provider
  permission refusal remain; scope is never an authority grant. Source repair
  failure restores the claim without executing, and receipts repair the actual
  child ID. Refusal evidence/cancellation failure does not retire pending work.
  Real processor/ledger/History ports use deterministic router/domain fixtures.
- Five actual failed-return writer tests cover atomic rollback, exact predecessor,
  idempotence, preflight terminal-only rejection, hydration/consumption/replay.
  Actual serial/parallel tests also exercise the failed return and anti-recursion.
  This still does not prove the failed Redis transaction or real model delivery.
- SDK combines one actual query's ordinary Append/Steer queue with public
  content-free native notices. Auxiliary notices neither consume promised Append
  nor keep a completed primary query open. Delivered requires the primary and
  notice UUID in the successful result. Public launch validation, readonly fences,
  compaction settings, diagnostics/archive and cleanup are retained, along with
  fork active-run dispatch and exact input consumption. Archive I/O is ordered
  best-effort diagnostics, not a reason to delay read/cancellation evidence.
  **29/29** SDK source tests pass after meaningful REDs. This is a deterministic
  provider seam, not a live installed SDK contract.
- The installed public SDK is **0.3.285**, while fork's real command-lifecycle
  verification pins **0.3.280**. The version gate fails honestly; no constant was
  relabeled. The isolated preserved-data live probe actually ran and failed with
  `authentication_failed` / `Not logged in`; its synthetic error result is not
  ordered command-start/model/result UUID evidence. No credential/config was
  copied or changed. Its own transcript, logs and results remain in
  `/tmp/sol-a2a-1577-sdk-contract-GViLqq`. Do not retry without changed authentication
  conditions, or loosen/relabel the verified version based on fixture success.
- Automatic merge had restored references to deleted `replace_final` and
  glass-box supplements without their owners. Actual routes failed on those
  undefined names. Fork commits **f8071e44ae** (named R; callback is independent)
  and **c94a58ac73** (retired redundant supplements/re-invoke) explain the removal;
  those behaviors remain retired, not patched with fake owners/false grants.
  **41/41** actual source route/preflight/TurnExecution tests now pass. Incoming
  Message-custody SDK fixture and projection conflict tests still need explicit
  owner migration; their first load failures are retained, not counted green.
- New refusal/processor/failure-return/preview source seams pass **19/19**.
  Scoped formatter exits 0 with 98 warnings/5 infos (16 files); unsafe suggested
  fixes were not applied. All raw anchors and limits are in consumer evidence.

Next remains HTTP/MCP history/unread exact-child adoption, public repair/restart
projection consumers, semantic F202 seams and Web. Keep same-checkout full builds,
owned Redis and browser acceptance for the final aggregate candidate, not these
intermediate source checks. No task300/overall A2A, human or soak gate is closed.

### Fifth cut: actual HTTP full drill and fresh compiled MCP consumer

Six more indexed conflicts are resolved (five MCP source/test files and the
document route); **139 remain**. The census now filters its path array from the
actual unmerged index rather than leaving the prior thirteen resolved paths in
the current list. HEAD/MERGE_HEAD remain frozen. `callbacks.ts` has no text
markers but remains indexed unresolved: typed action and hold seams still block
the complete registration; removing markers is not consumer compatibility.

- The prior managed SDK checkpoint passed **128/128** source tests (61 consumer,
  26 SDK fixture, 41 route), but its version gate and live authentication lane
  failed. Overall exit 1 is retained, not relabeled a successful SDK contract.
- Exact `get-message` registration is a production facet called by callbacks,
  retaining visibility, whisper, full/preview, local-review and sparse-cursor
  boundaries. Unpublished ordinary queued bodies must pass exact running child,
  owner/thread/target/parent and LifecycleActiveRun checks before atomic adoption.
  Oversized full drill uses the same QueueProcessor as thread-context; preview,
  scheduled owner, missing/terminal/wrong child never retires a target.
- Real HTTP RED **2 pass / 4 fail**, chunk `87583f`: the old publication guard
  rejected eligible queued user bodies before adoption. After fixing ordering,
  a History throw exposed a 409/503 classification mismatch (`07690d`). Explicit
  returned conflicts stay 409, thrown store failure is 503; both restore the
  exact claim. **17/17** drill cases now include three freshly compiled MCP →
  actual Fastify/auth/QueueProcessor/History consumers, not just helper tests.
  HTTP transport uses `app.inject` in the fetch seam; no real socket/model/Redis
  or complete callback-server claim. Source API plus same-checkout compiled MCP.
- Public document scope/immutable UTF8 assets/current authority remain intact;
  fork rich events retain exact response/invocation association. Three real MD
  HTTP/renderer tests pass; accepted own assets stay in temporary evidence dirs.
  This is not fresh Collective Work authority or PDF/DOCX acceptance.
- Finance dependency was not built after ignore-scripts install, so initial MCP
  compile failed TS2307 (`6ca52f`). Fresh same-checkout finance and MCP builds
  then passed. MCP keeps explicit history/unread, stable cursor arguments,
  contextScope/tail boundaries and honest oversized drill pointers; agent-key
  facade remains independent, and the retired replace_final request cannot
  replace R. **20/20** targeted compiled MCP transport/registration/budget tests
  pass (`8f6066`), after retaining the missing drill-description failure
  (`d8c99a`). The conflicted governance snapshot and server terminal producers
  are not considered complete by transport tests.
- Thread-context additionally requires exact child/live-run proof for all queued
  full exposure, including message-less seen-only rows; that aggregate endpoint's
  history/unread pagination and consumer matrix remain unverified this cut.
- Scoped format succeeds; API scope has 75 warnings, MCP scope six. Unsafe fixes
  were not applied. No old finding, human/soak or aggregate gate is closed.

Next: post-format verification, canonical typed action/hold terminal consumers,
complete HTTP history/unread/cursor matrix, governance snapshot derived from the
final implementation, then F202/Web/full build/owned Redis/browser acceptance.

## Sixth-stage typed action / History checkpoint

- Managed fifth-stage verification completed in
  `/tmp/sol-a2a-1577-http-mcp-check-X4nioG`: fresh shared/finance/MCP builds and
  208 source/HTTP/compiled-MCP/build-contract regressions passed. This does not
  include a full API/Web build or rerun the retained SDK authentication failure.
- Direct action recovery now joins canonical QueueLedger pending rows with
  History source → response → exact child → immutable parent record. Successful
  handling requires the same tenant/thread/target, source entry, lease/generation
  and executor key. Neither Message-custody receipts nor the expiring parent-key
  index are recovery authority. Public legacy key support is a read-only codec.
- Wrong scoped index hits were observed RED (`bac738`) before immutable record
  checks. A later RED (`09bf7a`) showed that an old interrupted attempt outranked
  its current pending replacement; evidence now overrides only that exact source,
  not every source in the generation. Canceled/failed observations still refuse.
- Safe-wait refresh retains public bounded retry/CAS checks and generation-stable
  append keys while using the fork's atomic Message + Queue admission. The whole
  callback file is still unresolved; source helper tests do not prove complete
  HTTP authentication, registration or crash transactions.
- Recovery response RED (`bce9ff`, 18/19) showed already dispatched History was
  reported as missing persistence after pending retirement. Exact durable History
  now reports committed delivery and its separate execution outcomes without
  scheduling. Missing/mismatched lineage or failed reads remain unverified, and
  absent pending work is not claimed to prove it was never admitted.
- Targeted source tests passed 32/32 (`587b1b`): 20 new production in-memory action
  proofs, six real QueueProcessor seams and six existing fork carrier regressions.
  Refactoring the fixture retained 20/20 (`2ba976`) and removed its new complexity
  warning; newly factored action production functions also have no scoped warning.
  Earlier harness failures (retired transitive import, diagnostic worker flags and
  fixture constructor/terminal/adoption mistakes) remain recorded separately.
- One further index conflict is resolved; **138 remain**. Public former
  Message-custody action fixtures, full callback HTTP retry/race tests and owned
  Redis recovery still need migration and final same-candidate verification.
  No aggregate approval, merged commit, deployment, human acceptance or soak.
- Shared issue #6's complete batch/event reading ledger is a separate follow-up,
  not delivered by this integration. Preserve output identity and process/final
  channel metadata during the later provider/Web integration.

Next: post-format same-checkout source and transport checks, then finish typed
hold and actual history/unread consumers. F202/Web/full builds and isolated
persistent/page acceptance remain required. Runtime/config/user data untouched.

## Seventh-stage hold / scheduled wake consumer cut

- The sixth-stage managed checkpoint completed in
  `/tmp/sol-a2a-1577-action-check-AhgTSo`: 234 tests passed, fresh shared/finance/MCP
  builds passed. No complete API/Web, actual SDK authentication or Redis claim.
- Four more indexed conflicts are resolved; 134 remain. Hold routes preserve the
  public atomic sliding-window quota and its authority-clock retry pair, structured
  owner-fence reasons and resumable gate result/continuation presentation. Fork
  waiting History-before-replacement, atomic Message+Queue wake ingress, retired
  command evidence and lost process-local runner recovery remain authoritative.
- Actual route RED `67441b` showed a definite waiting History failure leaked its
  quota reservation; the exact event is now compensated. Unknown or committed
  outcomes retain their task and reservation. A second RED showed overlapping sweep
  cycles; public in-flight serialization is now composed with fork lost-command
  recovery. Expanded auth/route/History/compensation/tombstone tests pass 13/13
  (`08e27d`). The quota stub is not SQLite/Redis backend acceptance.
- Retirement provenance is fork commit `f426fb7902`: the former manual managed-hold
  and ordinary A2A terminal services/routes were deliberately removed with the
  unified lifecycle. They cannot be restored as a second pending owner. MCP's two
  stale writer advertisements were independently observed RED (`e4da20`) and are
  removed from the candidate source; read-only protocol event inspection remains.
  Fresh compiled MCP verification is still required, not presumed from source.
- Reminder wake delivery remains one atomic scheduled envelope, not public's
  append-then-trigger pair. Public resumable terminal consumer coverage is retained
  alongside fork urgent ingress and failed/retired/legacy replay tests.
- The expanded recovery attempt first failed on unresolved imports (`aa93d6`).
  After resolving them, 45/47 passed; two failed because ignore-scripts installation
  left the existing better-sqlite3 12.8.0 binding absent (`a954b2`). Prepare only that
  exact local dependency and rerun; do not substitute a stale binding or skip tests.
  Scoped formatter succeeds with ten retained warnings, no unsafe fixes applied.

Next checkpoint: bounded local native dependency preparation, real memory SQLite
binding/quota and durable recovery tests, fresh compiled MCP retirement consumers.
Full history/unread, remaining owners, F202/Web, Redis persistence and aggregate
same-candidate acceptance remain pending. No task300 completion, merge or restart.

The prepared native/consumer command did **not** start: managed hold registration
returned 429 (3/3; retryAt 2026-10-06T14:39:53.721Z). No retry or alternative
identity registration is attempted. Hand the exact prepared foreground checkpoint
to astra under existing task300 coordination, then resume implementation from its
actual results. This is execution handoff, not aggregate code review or completion.

Actual foreground checkpoint returned by astra352: all 13 lanes exit zero,
completed 2026-10-06T13:57:35.081Z; author read back results and lane logs.
The exact existing local better-sqlite3@12.8.0 install and real memory write/read
passed. Hold 13, recovery 41, SQLite quota 19, compiled MCP retirement 2 and
read transport 16 passed (91/91). Fresh shared/finance/MCP builds passed;
Biome retained ten warnings. The missing-binding failure and rejected 429 remain
historical evidence, not silently relabelled. No automatic callback was registered.
HEAD/MERGE_HEAD and 134 conflicts remain unchanged; SDK authentication/version,
complete HTTP history/unread, Redis, API/Web/F202 and aggregate gates remain open.

## Eighth-stage complete callback composition and wait ingress

- Three further indexed conflicts are resolved in callbacks, multi-mention and
  callback tests; **131 remain**. Complete callback composition now imports and
  authenticates real HTTP history/unread consumers. Public F324 selection/cursor/
  tail behavior is retained without reinstating the retired ordinary read-to-send
  veto (fork `f426fb7902`). Existing rich-block response identity and public
  interim/final lifecycle tests are both retained.
- Exact running child and LifecycleActiveRun are required before queued full-body
  exposure. New in-memory production HTTP seams cover incorrect child/parent/
  tenant/thread/target/status, missing ActiveRun, failed History commit and claim
  restoration, thrown stores, sibling retention, sparse/cross-thread/oversized
  non-exposure, unread tail continuation and typed wait/action/scheduled fences.
  Fresh existing MCP dist is exercised through that actual HTTP composition;
  this is not a complete fresh API build or Redis recovery claim.
- Actual Connector → PersistedQueueDelivery → Queue → HTTP RED `01bcaa`
  reproduced loss of a wait carrier stored only in Message source metadata:
  ordinary History read could adopt it. Explicit producer carrier now survives
  atomic ingress to the canonical Queue execution field, and the actual GitHub
  wait publisher supplies it. Category or prose alone still creates no authority.
  Existing pending rows and concurrent admission winners reject added, removed
  or altered carriers rather than retrofitting old immutable work.
- New HTTP seams passed 22/22; producer category plus actual GitHub publisher and
  connector composition passed 42/42 (`ea1efe`). Selected callback reads passed
  67/67 earlier. Broader callback run `5d00cd` passed 236/237: the remaining old
  fixture omitted the exact LifecycleActiveRun dependency; after supplying the
  actual tracker, its targeted rerun passed (`e2f49c`). Keep that failed run and
  perform the post-format full rerun; do not relabel the original run green.
- F323 deployment callback registration now uses exact lifecycle input evidence
  rather than the removed managed-hold service. Expanded actual route fixtures
  passed 7/8 (`cf8391`), exposing a separate pending publication migration:
  immediate-current-turn delivery still uses the old MessageStore-only connector
  wiring, while the public lifecycle retains append/wake assumptions. Migrate
  current-turn History evidence and background atomic Queue admission coherently,
  preserving currentExecutionClaim, boot/recovery protection and admission retry.
  Merely replacing the fixture port would incorrectly queue a duplicate turn.
- Biome's scoped write passed (`b588fd`) with 43 warnings and one info, no unsafe
  fixes. A managed checkpoint will rebuild shared/finance/MCP and rerun complete
  callback, multi-mention, typed ingress and transport coverage. F323 known failure
  remains separate; native preparation is not rerun, SDK authentication/version
  remains unverified. No task300 completion, final review, merge or restart.

Actual eighth-stage checkpoint completed 2026-10-07T02:15:11.136Z in
`/tmp/sol-a2a-1577-callback-check-hzUKIR`. Author read all eleven lane logs:
fresh shared/finance/MCP builds pass; complete callback + actual multi-mention
232/232, typed producer/publisher 42/42, HTTP/fresh-MCP/drill/document 42/42,
compiled MCP retirement 2/2 and transport 16/16 pass (**334/334**).
No fail/cancel/skip/todo; scoped Biome exit zero with 43 warnings and one info.
The harness verifies all named test files before launch. Prior failed invocation
used the wrong multi-mention filename, so its 236/237 count is not multi-mention
coverage; the actual route file is included in this new 232-test lane.
HEAD/MERGE_HEAD and 131 indexed conflicts are unchanged. F323's earlier
7/8 failure is explicitly outside this checkpoint; all aggregate gates remain.

### C5 integration seam requiring contract alignment

Public F323 requires immediately satisfied registration to stay within its current
execution, but later boot recovery to reuse the same Message ID. Its lifecycle
still publishes through MessageStore-only connector wiring and a second wake
callback (`DeploymentWaitLifecycleService.publishPending` and runtime composition).
Fork atomic delivery cannot simply replace that dependency: immediate publication
would enqueue a duplicate execution; publishing it as History first and later
calling atomic delivery under the same key returns terminal-owned and cannot
resurrect the retired source. See the retained route RED and public lifecycle
tests for immediate match/failed-child recovery, plus ADR-043 C1/C2 boundaries.

Proposed alignment for coordinator review: current-turn callback/Task evidence
stays durable without a Queue wake, keyed to its exact claimed child; if that child
fails or a later boot recovers it, admit one separately keyed recovery attempt
under the same Task generation/outcome/carrier. Successful child terminal truth
does not enqueue. This must not create a second pending owner or alter historical
messages, and the public same-message assertion would require explicit adjustment.
Alternative is a new atomic bind of an existing History message to Queue, which
would conflict with the accepted no-retired-source-rebirth boundary. Do not choose
that alternative implicitly or fake a fresh Queue admission from terminal-owned.

### Ninth-stage C5 approved publication and recovery implementation

Astra363 accepted logical outcome / stable transport attempt separation under
the existing task300. This supersedes the proposal above: a later boot alone is
not recovery proof. Missing, running, mismatched or unreadable child evidence stays
unverified; only exact canonical child terminal truth permits the bounded recovery.

- Immediate current-child registration stores a Task publication receipt and
  immutable History notice, returns the complete notification through the actual
  HTTP/MCP response, and creates no Queue entry or second wake. Saved evidence is
  not model consumption or business completion.
- Failed-child recovery releases the claim and allocates one stable transport
  identity in a full-state generation CAS. The original History message is never
  rebound; the new atomic Message+Queue admission retains its immutable wait
  carrier and links the same outcome, original notice and exact child claim.
  Receipt loss, concurrent workers and Task acknowledgement CAS failure reuse
  that attempt. Successful child completion creates no recovery wake.
- Unknown History commit is reconciled by exact identity/scope/content before
  claim release. Lookup errors or mismatches retain the claim. Legacy matched
  claims without publication evidence stay unverified rather than inventing a
  safe History-to-Queue migration. Retirement replay does not create another row.
- Real deployment composition now supplies History plus canonical atomic delivery;
  the old separate invoke/autoexecute wake is removed. No new pending owner is
  introduced. Full callback index conflict resolution remains pending.
- RED `99ebba` (10 failures), additional safety RED `509020` and codec shape RED
  `9e473d` are retained. The codec mismatch was fixed by producing absent `await`
  rather than an undefined field, not by loosening the assertion. Final source
  rerun `2beb55` passes **55/55**: 18 actual in-memory publication seams,
  26 lifecycle, 9 actual route/MCP and 2 task-route cases; no skip/cancel/todo.
  This includes a real Task Redis codec roundtrip, not a live Redis acceptance.
- Scoped Biome `babaa0` exits zero with three retained complexity warnings in
  existing validation/observe/registration methods. New claim/publisher helpers
  have no warnings. Directory guard exits zero with existing warnings and no new
  exceptions. Fresh shared/finance/MCP and broader consumer rerun is prepared at
  `/tmp/sol-a2a-1577-deployment-check-kCDZJr`. Managed command registration succeeded
  (`hold-ball-1791340681263-92fqzx`, PID 67603); completion callback is registered,
  Actual completion at 2026-10-07T02:38:24.818Z is green: all 13 lanes exit zero,
  389/389 tests pass with no skips/cancellations/todos. Fresh shared/finance/MCP,
  source API callback/route composition and compiled MCP transports were exercised.
  This is not a full API/Web build, live Redis, model dispatch or aggregate approval.

### Tenth-stage observational projection and native freshness cut

Eight additional indexed conflicts are resolved; **123 remain**. Fork retirement
commit `c94a58ac7388ba077281ab0608f2ec26a81d8551` explains why F117 replaced the
post-message HELD gate, MCP piggyback and notice-driven reinvocation. Those three
unreferenced runtime files are removed again, recoverably in Git; all type-only
production consumers now use the retained native read-side message contract.
Legacy gate test conflicts remain visible for their own semantic migration.

The useful public settlement projection is retained and composed with the fork's
canonical liveness algorithm. It reads the same scoped child snapshot, respects
terminal response filtering and dynamic Active Run ordering, and creates no new
owner, Queue write, receipt or business completion. Native freshness retains
bounded live-exposure scans, incomplete-scan continuation and provider idle
delivery. Its instructions explicitly select `readIntent: "unread"` independently
of full projection, preserving the unread-delta/history warning.

RED `d5207b` had three genuine failures; after migration, `87ad11` passes 22 tests,
with one honest private-staging absence skip. Coverage includes the actual
canonical resolver, exact native auxiliary ownership, foreign scope, failed/later
child lineage, native process exit, terminal R filtering, incomplete scans with
no cursor write, idle notice delivery and action-only custody. Biome `8d9103`
exits zero with one retained scanner complexity warning. F202 FYI376/378 does not expand this task: frozen `e3efa166`
remains the input; successor `78cd6043` is not consumed.

Additional semantic checks exposed a wrong module for `StoredMessage` and an
unnarrowed public frontier/legacy closure annotation union. These are fixed from
the actual contract; five production files now have zero semantic diagnostics.
The public Live exposure fixture also required canonical MessageFrom rather than
the retired catId append projection; the initial five failures and the author's
wrong discriminator correction are retained in evidence. Its five real-store
cases now pass, including authenticated ordinary post HTTP injection: pending
input stays unread, no HELD gate returns, and only explicit read can advance it.
This extends the earlier subset, not a full F317 validation or live provider call.
Post-format checkpoint is prepared at
`/tmp/sol-a2a-1577-observation-check-u9PpNP`; managed registration succeeded
(`hold-ball-1791341394607-wk1k8y`, PID1537, 3/3 rolling window used). All 16 lanes
completed successfully at 2026-10-07T02:50:43.769Z: 417 tests pass, one private
staging absence skip, zero failures/cancellations/todo; shared/finance/MCP rebuilt
and five-file semantic diagnostics are zero. Format warnings remain (one scanner,
three C5); this is not full API/Web/Redis/model or aggregate acceptance. Do not
rerun or register another hold for this command. FYI383 keeps F202 work in its original
checkout and leaves the frozen input unchanged.

F202 FYI368/369 leaves its frozen tree and patches unchanged; original Host
thread performs new validation, and any shared-file delta requires precise later
handoff. No writes to that worktree. HEAD/MERGE_HEAD and **123** indexed conflicts
remain. SDK authentication/version, old owner/governance, final persistent recovery,
API/Web/F202 build/page/hooks/review and task300 completion remain open.

## Eleventh cut — scheduler and GitHub producer single admission

Four more indexed conflicts are resolved (**123 → 119**): IssueCommentTaskSpec,
ConflictCheckTaskSpec, RepoScanTaskSpec and TaskRunnerV2. Public cancellation,
object-budget signals, rate-limit handling and bounded timer lifecycle survive;
fork canonical Queue admission remains the only wake owner. Conflict outcome
types consistently use the GitHub specialization rather than stale aliases.

Two actual consumer failures were reproduced and fixed, not hidden by fixture
changes: an explicit `admitted=false` repo-scan result previously advanced the
notification dedup, and a reminder whose admission failed could save a diagnostic
receipt then report `RUN_DELIVERED`, prematurely retiring its wake. Notification
dedup now requires proven admission; diagnostic persistence still surfaces the
failure and the actual scheduler retries the original stable identity. Secondary
receipt failure preserves both errors. The user-facing receipt explicitly says
the original task remains pending recovery, not that delivery succeeded.

The public lifecycle SLA/overlap retry composes with the fork managed-command
retry and an active/disabled/retired hold fence. Tests exercise the actual timer,
SQLite memory records and canonical in-memory Queue, including unchanged identity,
zero pre-recovery admission and one post-recovery wake. Old trigger-based fixtures
now observe Queue admission; terminal status receipts are distinguished from
business wake (unknown owner/expired/replaced hold never targets a cat).

`fbe50d`: **107/107** primary source consumers pass. `a5f4d3`: **90/90** additional
publisher/budget/template/timer cases pass. Seven production files have zero
semantic diagnostics (`4dc68a`). Format exit0 retained 30 warnings/two infos,
with the unused legacy type imports subsequently removed; no unsafe fixes or
exceptions were added. RED and author fixture failures remain in consumer-evidence.

The prepared joint checkpoint was run in the foreground by astra: retained
`/tmp/sol-a2a-1577-scheduler-check-T9kE6m/results.json` is **failed**, 590 pass,
one failure/one existing private-staging skip. Source hashes were unchanged.
The original managed registration was rejected 429 and never started a command;
the foreground result must not be confused with that registration.

Failure408 was reproduced deterministically (`9166a9`): when the first timer and
the fixed 50ms sample are both overdue, the async pipeline cannot arm/run its
retry before the sample. The test now controls Date/setTimeout and drives actual
TaskRunner timer/finally/retirement to completion without wall-clock sleep.
Expired, retired, disabled and expiry-during-settlement no-retry cases remain;
no production retry logic or expected second attempt was weakened. Reminder's
diagnostic content indentation is fixed. The initial new test formatting failure
is also retained rather than overwritten.

Fresh joint correction `/tmp/sol-a2a-1577-scheduler-fixed-7joxE9/results.json`:
16 lanes exit0, **593 pass / 0 fail / 1 existing skip**, fresh shared/finance/MCP,
seven production semantic checks clean, source hashes unchanged, 28 Biome warnings
and two infos. This does not prove a fresh aggregate API/Web/Redis/provider/page.
SDK proof remains absent; F202 remains immutable `e3efa166`.

## Twelfth cut — Collective reconsideration's canonical owner

One indexed test conflict is resolved (**119 → 118**), with two auto-added
production consumers migrated together. `collective-owner-work-reconsideration`
no longer performs Queue enqueue → Message custody append → manual backfill /
rollback / Message-derived restore. Current permission precedes canonical atomic
Message+Queue admission. The row retains unknown owner provenance, exact singleton
target and collective-participation execution restriction. Immutable source/purpose
and current Connector permission remain the authority; Queue scope is not a grant.

The downstream `requireCurrentReconsiderationSource` also consumes that exact
indexed producer envelope, not a vanished Message custody record. Before-provider
and callback consumers still validate current permission; a forged source, target,
sender or purpose cannot borrow another grant. No Host worktree or F202 successor
was copied, and no new product/plugin responsibility was created.

After dispatch, recovery inspects only canonical actual History refs and the exact
response. It never rebuilds the Queue from History. Failed, canceled, unknown,
withdrawn and completed-but-unread inputs do not imply successful classification;
pending actual child and proven completed child stay distinct.

RED: retired-owner import `30e7f5`, old custody-based authorization `ea8dec`.
GREEN: **14/14** (`6c6e04`) route/current grant/atomic failure/hydration/actual
terminal+unread/sender-purpose corruption/owner escalation cases. Author fixture
mistakes are retained. Full Collective provider/refusal/callback journeys and
startup/composition remain pending; this is source-consumer evidence only.

The actual `CollectiveCurrentContext.resolvePublic` consumer now also has a
post-dispatch source test: it retains the exact producer grant without a Queue
row, and rejects changed Host binding, a different cat and revoked permission.
This is the real context resolver with fixture Connector I/O, not a live provider
or full accept-work journey. Fresh post-format joint check
`/tmp/sol-a2a-1577-collective-check-URkd7W/results.json`: **611 pass / 0 fail /
1 existing private-staging skip**, 17 lanes exit0, nine production semantic
checks clean, source fingerprints unchanged, fresh shared/finance/MCP builds.
Scoped Biome retains 28 warnings and two infos. Full candidate gates stay open.

## Thirteenth cut — exact native control, canonical Queue withdrawal

Three indexed conflicts resolve (**118 → 115**): active-execution-routes,
queue routes and queue API tests. Public receipt hooks and exact frozen child
checks coexist with fork per-cat Stop reconciliation and durable response/input
settlement. A request carrying `expectedInvocationId` cannot be retargeted to a
replacement parent/child; missing canonical child or incomplete control evidence
fails closed. Legacy Stop without that selector retains its existing same-cat
intent and recovery behavior. The tracker is rechecked after an awaited child
read against the chosen candidate, not the stale original parent. An initial
41/42 result caught precisely that composition error (`bf5dc1`), then 42/42 passed.

Scoped native Queue withdrawal retains the canonical reversible claim rather
than restoring Message custody. Exact source and pending targets are checked
before and after the async claim. An already-dispatched sibling is checked in
History, not guessed from the remaining Queue target set. Unknown source History,
scope changes and persistence failure release/restore the claim without canceling
another input. Author history is retained; adjacent canonical sources cannot merge.
The old multi-source fixture was replaced by explicit separate-source assertions,
not by reconstructing the removed coalescing owner.

Mutation RED `d2d0c8` confirms that omitting the post-claim check would cancel a
two-target row with a frozen single-target request (200 instead of409). The guard
is restored. A separate author fixture passed messageId instead of entryId
(`4ad265`); it is corrected, with the failure retained. Real HTTP + in-memory
ledger/projection/settlement and receipt-hook fixtures pass **120/120** (`3d758d`).
The two production files have zero semantic diagnostics (`8cf658`). Format exit0
retains existing complexity/non-null warnings; no new exceptions or unsafe fixes.

Boundary audit: whole-public would drop fork settlement/reconciliation, while
whole-fork drops public frozen-child and native receipt guards. Explicit exact
control versus legacy per-cat intent is not an alternate delivery fallback.
Principal, child ownership/running state, post-await tracker, durable claimed
target set and History source validate different facts; none replaces another.
There is still one pending owner and one terminal authority.

Joint script `/tmp/sol-a2a-1577-control-check-NUAf9W/run.mjs` was executed
by astra and returned in source448, completed 2026-10-07T03:39:46.872Z.
All 19 lanes exited zero: fresh shared/finance/MCP, source control/Collective/
scheduler/C5/callback/transport, **731 pass / 0 fail / 1 existing private L0
staging skip**. Eleven production files had zero semantic diagnostics; format
retained 55 warnings and two infos. All 33 input fingerprints and before/after
HEAD/MERGE_HEAD/115-conflict checks were unchanged. No runtime, Redis, provider
or SDK authentication was started. No final API/Web/page/aggregate or task300
completion is claimed.

F202 source update428 is recorded only as a later shared-seam anchor: unadopted
TREE `f60e12b2e23263b7383305b4b4a174092c9128bd`, delta SHA256
`09707807536993b0afb9d0df5c4687ee580189da4ae4bbfef3559af50d3b51da`.
Its index/cloud registry/config hooks, runtime option, package and generic Web
actions must later be compared semantically. Current accepted input remains
immutable `e3efa166`; batch7's missing `resultRender:rows` and pending Settings
authorization/revoke journey belong to the Host/plugin owners, not this writer.
Neither successor tree nor its evidence substitutes for final candidate review.

Sources445/448/453 add the five-file unadopted wiring successor TREE
`8b7f5b1ffb204b1dc409e98e5fc0021bbf0bef71` based on `f60e12b2`, delta SHA256
`39f0d144098fa3e66051d4e8299ccc9e4f42461afacba31fb663a85e7a4d2df6`.
Its production `createCloudConversationComposition` shares the registry and
awaits cat reconciliation before reevaluation. Read-only followup closed the
manual-registry testing P2, but is not commit approval. The missing plugin
`list.resultRender` still leaves artifact 6pass/1fail. If f60 is later adopted,
this successor must be evaluated with it; accepted input remains e3efa166.

### Fourteenth cut — actual Collective refusal and full Host consumers

Source448's passed checkpoint is consumed; index conflicts remain **115**. This
cut migrates automatically added full Collective fixtures, rather than counting
their unchanged index entries as newly resolved conflicts. They now use atomic
Message/Queue publication, same-ledger hydration and Registry-authenticated exact
child admission, exposure and History terminal commits. The parent invocation is
not used as a child read witness. No Message custody reconstruction is restored.

The real InvocationRecordStore exposed a production RED (`be5a3d`, diagnostic
`e2dc0a`): catch already committed failed, then refusal cleanup requested another
failed self-transition. The store correctly rejects terminal self-transitions,
so cleanup retained the old g1 claim and blocked g2/B. The fix only reuses exact
id/thread/owner/source/singleton-target **and identical failed error** evidence;
otherwise it requires the terminal writer and exact durable readback. The generic
update helper remains strict. Unknown/missing readers and changed record/error
cannot authorize cancellation. Twenty-six focused tests passed (`b7cd10`) before
the final missing-reader regression and type corrections; this is not yet the
fresh final checkpoint. Removed cache/isPaused APIs and scripted missing child
terminal fixture failures were fixed with original failures retained.

Full reconsideration HTTP/Connector/Service and callback/current-context tests
passed **8/8** (`c6e135`) after the same checkout's missing Collective Service/Client
outputs were rebuilt. These are scripted Cats and fixture Human auth, not models,
accounts or production Host composition. Owned Service servers bind random ports;
fixture close now retains their persistent disk directories instead of deleting
them. The eight test worlds closed their own servers and retained all data.

Boundary/fallback audit: exact durable failure evidence reuse is idempotence,
not a second delivery path. Failed pre-receiver transport restores the same
pending source; it does not replay an admitted or terminal child. Queue remains
the only pending owner, and the exact child History owns admission/terminal truth.
Type-check failures and missing-build/old-import failures are preserved; no
assertion removal, authority relaxation or suppression is used to pass them.

Prepared fresh expanded checkpoint:
`/tmp/sol-a2a-1577-collective-full-check-oBQZtP/run.mjs`. It includes full manual
Host/validation/reconsideration consumers, fresh package builds, prior control,
C5/callback/typed/HTTP/MCP regressions and scoped production diagnostics. Inputs
are fingerprinted and exact HEAD/MERGE_HEAD/115 checked before/after. The result
completed at 2026-10-07T03:55:12.437Z: **538pass/6fail**, no skip/cancel/todo.
Fourteen lanes exited zero; full Host consumers were 33pass/6fail. All six
failures stopped at five old append inputs lacking canonical `from`, before the
permission/recovery assertions. The three affected files now use external
Collective, agent publication or system collective-work provenance as appropriate;
the forged embedded actor and ownership/revocation assertions remain unchanged.
The strict MessageStore validation is not relaxed. Four production semantic
checks had zero diagnostics; format exited zero with 40 warnings. All 20 input
fingerprints and frozen HEAD/MERGE_HEAD/115 were unchanged. The failed results
and retained isolated fixture data remain available; a fresh regression result
is required, not replacement of this failure with older green evidence.
No full API/Web/page/aggregate or task300 completion is claimed.

Correcting fixture senders exposed an actual writer omission: 38/39 passed
(`4c75ae`), but a current g2 execution receipt still supplied legacy `catId`.
The same-family first-admission suite was then run before fixing the writers:
0/6 passed (`91e06a`), including a cold Host's missing immutable source writer.
Both now use canonical provenance: Host-owned user for the protected receipt,
external Collective with factual sender for the recovered first assignment.
Grant validation, Service evidence, original Task admission and per-revision
idempotency keys are unchanged. New source-provenance assertions supplement the
existing first g2 admission, crash/receipt replay, g3 reuse, closed/duplicate Task
refusal, cold startup and refused-generation fixtures. An initially incomplete
new sender assertion (10/11, `a0dfe5`) was corrected to require the preserved
external sender, not remove it. Fresh expanded checkpoint is prepared in
`/tmp/sol-a2a-1577-collective-senders-slRl6T`; prior failed results remain intact.

Post-format first-admission plus manual consumer regressions passed **11/11**
(`040532`), no fail/skip/cancel/todo. This includes actual protected receipt
and recovered external sender assertions. Fresh expanded checkpoint still must
complete; no older failed lane is relabeled. All owned Service servers closed
and isolated persistent directories were retained.

Source476's expanded checkpoint completed at 2026-10-07T04:02:08.208Z:
**550/550**, no failure/skip/cancel/todo, all 15 lanes exit0. Full Host and
bootstrap consumers 45/45; six production semantic checks diagnostics0.
Fresh shared/finance/MCP/Collective Service builds passed. Format retained
41 warnings, not zero-warning evidence. Frozen identities/115 conflicts and
24 file fingerprints were unchanged. These source-loaded API and fixture
HTTP results do not substitute for final API/Web/Redis/production-page gates.

## Fifteenth cut: atomic admission and exact-child restart fixture

Resolved the persisted delivery test and its shared fixture without restoring
Message custody or a second pending owner. All seven canonical fork invariants
remain, supplemented by real concurrent admission, validation rollback, delayed
atomic publication, lost acknowledgement followed by ledger hydration/replay,
and serialized producer-return/legacy classification tests. The fixture uses
actual InvocationRecordStore, LifecycleActiveRun and exact child History/prompt
exposure; it never substitutes parent invocation for child or labels persistence
as model consumption. Own scripted providers close with failed terminal evidence.

Fixture failures are preserved in evidence: wrong projection/method assumptions,
premature started assertions, type checks, and child wait before requesting drain.
Correction: `already_processing` can mean only claim acquisition. The recovery
test first requests normal drain, then waits for exact-child startup and exposure,
then verifies stable replay creates no second child. No extra sleep or weakened
production claim/terminal checks. Post-format **14/14** and both selected TypeScript
files diagnostics0 (`aee4ef`); scoped formatting has no warnings. Two files are
staged as resolved: **113 conflicts remain**, frozen HEAD/MERGE_HEAD unchanged.

Risk-matched consumer checkpoint prepared at
`/tmp/sol-a2a-1577-admission-check-ATCCWJ/run.mjs`; it reuses unchanged same-checkout
package outputs verified in source476, not another package build or final API/Web
acceptance. Existing SDK proof, old ownership/startup, F202 and aggregate gates
remain. Isolated fixture disk retained; no runtime/config/user data touched.

The fifteenth checkpoint completed at 2026-10-07T04:14:12.439Z: **564/564**,
no failure/skip/cancel/todo, all twelve lanes exit0. Both selected fixture
semantic checks had zero diagnostics; scoped formatting no warnings. Frozen
HEAD/MERGE_HEAD/113 conflicts and all 26 input fingerprints remained unchanged.
No new package build: unchanged same-checkout outputs from source476 were reused.

## Sixteenth cut: independent Redis execution identity and output fence

Resolving RedisTurnExecutionStore exposed a real automatic-merge writer gap:
CREATE_TURN_EXECUTION_LUA used ARGV10 for both immutable queueCompletionPolicy
and late-bound outputFence. Retaining either side alone produced an unreadable
durable child. Real Redis regression before the fix was **2pass/8fail** (`0ac7e1`);
its RDB/AOF and logs are retained at `/tmp/a2a-turn-esPyBQ`. The writer now appends
policy as ARGV11 while retaining fence at ARGV10. The strict codec, immutable
identity, late coverage and monotone fence are unchanged; no repair-on-read or
new queue owner is introduced.

Post-format **33/33** (`acaea2`) includes ten real Redis tests, thirteen memory
execution tests and ten startup guard regressions. Policy/fence matrix, actual
concurrent admission, identity drift, legacy no-fence reads without rewriting,
corrupt projection refusal, terminal race, response-pending and actual Redis
process restart are covered. Owned Unix socket only (`--port 0`); saved RDB/AOF,
keys and logs remain at `/tmp/a2a-turn-xbg72v`. Fixture processes were joined.
Initial fixture hook/readiness failure and unsafe-finally warning are retained,
not reclassified as product failures or suppressed.

The hold callback auth/schema fixture now supplies both durable recovery and
native quota dependencies: **15/15** (`4e6a78`), including owned memory SQLite
quota and the fixture's completed echo command. Three production semantic checks
diagnostics0 (`53af03`), four-file format check no warnings (`f56305`). Staged
resolved store and callback test reduce index conflicts **113 → 111**; the Lua
automatic-merge seam is also staged. Frozen HEAD/MERGE_HEAD unchanged.

Fresh risk-matched checkpoint prepared in
`/tmp/sol-a2a-1577-turn-persistence-check-whG40I`, now started through managed
command `hold-ball-1791346969832-6eea2i`; its completion is recorded below. Real Redis
evidence concerns TurnExecution only: it is not Redis Message+Queue transaction
acceptance, full compiled API/Web, final startup composition, page/human/soak,
legal commit or independent review. F202 accepted tree remains e3efa166; SDK
proof and old owner/governance/startup migrations remain open. Runtime instance,
configuration, user data and existing NeedsMe samples are untouched.

Source488's sixteenth checkpoint completed at 2026-10-07T04:23:37.801Z:
**626/626**, no failure/skip/cancel/todo, fourteen lanes exit0; three selected
production diagnostics0, scoped format no warnings, directory guard retains
existing warnings. All 31 fingerprints and frozen HEAD/MERGE_HEAD/111 remained
unchanged. No new package build; Message+Queue Redis and final candidate gates
remain open. All fixture-owned processes closed with persistent disk retained.

## Seventeenth cut: parent restart projection follows exact-child truth

The auto-merged StartupReconciler accepted a canonical TurnExecutionStore but
never consulted it before failing running/stale-queued parent records. A real
store source probe was **2pass/9fail** (`9f5e58`): the earlier child recovery
could preserve a live detached execution, only for the later parent sweep to
fail its callback projection and clear progress. This is not evidence that an
old Message custody owner should be restored.

Both parent sweeps now inspect exact parent/thread/user/target child records.
Any live child preserves the parent and progress; unavailable, mismatched or
unknown child truth stays uncertain via existing per-record error isolation.
Confirmed empty/all-ended children retain the previous orphan warning, without
changing child terminals or inferring successful delivery. Legacy callers with
no child ledger retain their old behavior; production passes the ledger.

Post-format **66/66** (`39140c`) includes thirteen new exact-child seam cases,
the two ordered actual reconciler passes, old parent/child startup, recovery
liveness and canonical Queue ledger tests. Format exit0 retains three existing
complexity warnings; it is not a zero-warning result. HEAD/MERGE_HEAD remain
frozen, **111 conflicts** remain, and old owner/governance migration is still
open. Risk-matched checkpoint prepared at
`/tmp/sol-a2a-1577-startup-check-kN0ZoQ/run.mjs`; it is not executed yet and does
not claim final index composition, new builds, SDK, pages, or aggregate review.
Selected startup/child/ledger production semantics diagnostics0 (`0aa47c`).
This new risk-matched validation is handed to astra for foreground execution;
author source writes pause until the actual result is returned. It does not
reopen a code review or mark task300 complete.

Source497 returned the actual foreground checkpoint: **450/450**, eleven lanes
exit0, 25 input fingerprints and frozen HEAD/MERGE_HEAD/111 conflicts unchanged.
The actual results and all lane logs are retained at the checkpoint directory;
owned Unix Redis data `/tmp/a2a-turn-HcSTG1` was saved and its own process closed.
This reuses unchanged source476 MCP outputs; final index/build/SDK/page gates
remain open.

## C6: retired wake selection cannot silently grant Task authority

Resolving the typed-wait callback fixture preserved all existing predicates,
exact-source/invocation fences and the public retired-first-source assertion.
The actual route now exposes the incompatibility: **19/20** (`6c33b5`), after
correcting an initially misplaced fixture retirement assertion (`859032`).
Both pure public classifications say `retired`, but two exact child input sources
still produce no private Task receipt in fork captureTypedWaitSource. The public
test instead expects event-order first-source bypass. This is a permission/source
contract difference, not a generic race or a source-code formatter failure.

Recommendation to coordinator: preserve exact entry-source authority and deny
ambiguous sources; a terminal observability projection must not select a private
Task continuation by event order. Any explicit per-source retirement drain must
remain separate from ordinary read adoption and from creating the typed wait
receipt. The original 19/20 RED is retained; coordinator message505 explicitly
approved denying ambiguous private continuation, not blanket rejection of retired
sources. No Message custody or old completion route is restored.

### Eighteenth cut — actual callback permission and canonical wake cleanup

C6 authority: `0001791348001337-000505-6335fb6a`. The fixture keeps the other
19 existing cases and replaces first-retired permission with denial. New matrix
covers two live/retired/mixed sources, input/wake order and primary placement;
a sole exact retired source still succeeds. Actual authenticated producers keep
public tracking installed but deny private receipts for wrong thread/user/cat,
child thread/target/invocation, missing inputs and unavailable History/child reads.

The new actual route matrix exposed three real permission gaps (**43/46**, chunk
`7ac7f4`): a self-consistent visible source from another thread and active children
with wrong thread/target could mint receipts. Capture now checks exact child
thread/target and rejects foreign-thread inputs, with lookup uncertainty inside
the existing fail-closed boundary. It does not use Ball projection/order or add a
caller-controlled selector. Valid receipts still reject changed owner, generation,
predicate, expiry, terminal Task and cross-child/thread/user/cat replay.

Post-format focused checkpoint **94/94** (`90f43a`): actual HTTP producer matrix50,
receipt/resolver36, canonical wake retirement5 and History adapter3. Original
fixture failures remain separate: `7e7d4b` 38/46 included misplaced fixture methods;
`294e82` 4/5 called a nonexistent ledger method. Neither was relabeled as product
failure. Correcting the fixture preceded the clean permission RED and GREEN.

Retirement proof uses real SQLite DynamicTaskStore CAS and actual atomic
Message+Queue → QueueProcessor → distinct child → failed response History.
The existing recovery engine consumes only that exact notification, disables its
Task once, preserves sibling Task/History and creates no replay Queue row. A live
child remains pending; wrong source/target/thread/user and replaced claim reject;
concurrent consumption CAS retires once. This is failed notification cleanup,
not business success, not arbitrary tool replay and not a new tracking receipt.
All owned SQLite files remain on disk, closed; no runtime/user-data access.

Behavior mutants in `/tmp/sol-a2a-1577-c6-mutants-NIFbQa/results.json` load altered
source only in their own process, leaving the production fingerprint unchanged:
removing uniqueness yields38/50 (12 actual failures), removing thread check49/50
(1 actual failure). Both execute the real route matrix; neither is a syntax-only
failure. Full post-format fresh shared/finance/MCP and surrounding callback/read
verification is prepared at `/tmp/sol-a2a-1577-c6-check-gszsRO`, not yet run.
Managed execution was rejected429 (rolling3/hour, retryAt05:22:49.837Z);
the command did not start. Hand off this exact foreground verification to astra,
not another code review or a retry of the same rejected hold.
Astra524 actually ran the exact runner: completed04:53:16.104Z,14 lanes exit0,
540/540, no fail/skip/cancel/todo. Root readback `f75898` read each lane and
confirmed29 unchanged input fingerprints,110 conflicts and frozen identity.
Fresh shared/finance/MCP succeeded;5 production semantic diagnostics0, format
one complexity warning retained. This completes this checkpoint only.

Index now110 conflicts, same frozen HEAD/MERGE_HEAD. Format passes with one
cognitive-complexity warning; no zero-warning or aggregate approval claim.
F202 input remains immutable e3efa166; SDK proof and final API/Web/index/pages,
hooks, independent review, human acceptance and soak remain open.

### Nineteenth cut — preserve readonly execution progress without custody

Two automatic public additions still consumed removed Message custody modules:
content modification execution and Collective owner request progress. Actual
content-view load failed (`4018cb`), so these useful projections were preserved
and migrated, not deleted or used to restore a second owner.

One shared readonly predicate validates pending Queue rows by exact owner,
thread, source, sender and target; only one matching pending row is accepted.
Actual/terminal progress instead follows the exact target's source dispatchRef
to its matching response History. An invalid or ambiguous receiver cannot fall
back to Queue. Missing evidence is unknown; storage failure remains a read
failure, not a delivered verdict. The helper does no adoption/retirement/wake or
Task mutation. Pending Queue IDs are not fabricated for started History.

Content execution additionally validates the exact child ledger, causal input
and distinct parent before exposing a Stop target. New identity negatives caught
a real inherited gap (`92c71d`,0/1): a returned child with another invocation ID
was accepted. Exact child ID and nonempty/distinct parent are now required.
Owner HTTP stages remain private local presentation, never a public Service
reply or private Work success. Public Collective provenance stays unknown;
the fixture's attempted strict elevation was rejected and corrected, not waived.

Post-format focused41/41 (`a90ad0`): actual owner HTTP20, readonly Queue/History
20 and content execution1 with queued/running/terminal and negative identity
matrix. Queue retirement and real failed provider are exercised; completed
presentation is separately labeled a read-model matrix, not actual Task success.
Original owner19/20 custody fixture failure, new fixture source omission21/23,
and three optional-sender type errors remain recorded. Seven selected production
semantics passed (`0eb967`); final child-guard change will be rechecked.

Behavior mutants in `/tmp/sol-a2a-1577-execution-view-check-PYqddt/mutants.json`
remove pending or receiver owner checks only in their process: each18/20,
one failed owner subtest and its failed parent. Actual production fingerprint
unchanged. Directory guard passes with warnings; queue-ledger now15 files,
kept together for one canonical evidence predicate rather than duplicating it
across domains. No exception added. Format retains complexity warnings.

The same directory's `run.mjs` was executed by astra and returned in source545:
15 lanes exit0,581/581, fresh shared/finance/MCP, seven production semantics0,
format3 warnings and directory warnings. Frozen109 identity and43 fingerprints
unchanged; author read every lane (`40a750`). This is specified consumer
verification, not code approval. Earlier hold429 remains; no new hold registered.
Index's one readonly port is wired but index itself remains unmerged/unverified.
F309 automatic native-control fixtures still contain coordinator/cleanup seams;
they are pending, not silently counted as green. No runtime/config/user data,
F202 input replacement, native/SDK retry, aggregate completion, merge or restart.

### Twentieth cut — real F309 native controls and durable source writer

The inherited native fixture initially could not load the conflicted review
dispatcher (`c2637c`). Its return path now retains public text envelopes and
explicit producer_return category with fork strict provenance and canonical
delivery; no coordinator or second pending owner. Actual submit then failed3/3
(`b335d2`): request-source lacked MessageFrom and still emitted old catId.
The writer now persists explicit authenticated user identity and rejects scoped
or sender-changing replay without rewriting the original Message. The temporary
human-enum mistake and remaining catId rejection are retained, not waived.

Canonical controls failed3/3 (`e8948e`): confirmation consumed removed legacy
messageId/allTargetCats fields, and the persisted Stop receipt view accepted a
getter returning a different child. Confirmation now validates canonical queued
entry/id/owner/thread/payload source/target; list checks exact child ID. Tests
cover foreign/system owner, thread, source, target and stale claimed rows. Native
DELETE remains the atomic authority, not these readonly confirmations.

Queue no longer merges sources. The former merged-source fixture is explicitly
ported to real same-source target expansion after confirmation: scoped delete
must reject the wider row, and whole withdrawal requires a separate human
receipt.503 commit failure, frozen confirmation replay, owner denial, unrelated
source preservation and persistent acknowledgement across another SQLite
connection remain covered. No real provider Stop was issued or claimed.

Broader source serialization failed to load (`a567ce`): automatic merge declared
two identical realtime carrier parser functions. One duplicate removed, both
existing carrier suites retained.52/52 targeted passed (`71f83b`) before final
queued-row/id guards. Four selected semantics initially caught missing system
owner narrowing (`b7e19f`); that fix is awaiting the expanded checkpoint.
Behavior mutants remove exact child or user-sender validation in memory only:
child2/3, sender2/6 (three rejected sender subtests and failed parent). Initial
strip-only mutant load failure is retained; corrected transform runs produce
real assertion failures. `mutants.json` proves production fingerprints unchanged.

All cancellation fixture SQLite/storage directories are retained and listed by
test diagnostics; only connections and own provider fixtures close. No persistent
storage cleanup remains in that helper. Original REDs and source-loader mistakes
are recorded. One conflict staged resolved,109→108, frozen Git identities remain.
`/tmp/sol-a2a-1577-native-control-check-UTLB94/results.json` actually completed
at 2026-10-07T05:25:23.683Z (managed wake source558). All17 lanes exit0,
632/632 pass, no fail/skip/cancel/todo. Fresh shared/finance/MCP and eleven
selected production semantics0; format12 warnings and directory thresholds
remain. Frozen identities108 and56 input fingerprints are unchanged. F309's
eleven owned SQLite directories and C6's five directories remain in lane logs;
no storage was removed. Not final API/Web/index/Redis Message+Queue/page/SDK or
aggregate approval. F202 still consumes only e3efa166; runtime/config/user data
untouched. This checkpoint precedes the next retirement-owner cut.

### Twenty-first cut — retire the old hold writer, retain observation and teardown

C1/C6 prohibit restoring the `complete-managed-hold` Message-custody owner.
Three source-map angles (current production imports, frozen fork/public Git
objects, real public consumers/tests) distinguish it from useful observation:

- Remove Receipt/Disposition/SourceSelection and their fenced legacy terminal
  writer. Remove the startup construction hunk and its now-unused settlement
  publisher. Five source files removed, recoverable from frozen public Git;
  no persistent data removed. Remaining index conflicts are not staged resolved.
- Keep `managed-hold-retirement` and supersession as pure Ball replay classifiers.
  C6 still uses them; classification is not Task permission or Queue cleanup.
- Keep the public process-local adoption registry: `DispatchAdoptionAuthority`
  uses its operation gate, and teardown must drain admitted operations and prepared
  reservations. Snapshot discovery is explicitly not private continuation authority.

New actual source seam initially5/6 RED (`466389`), then25/25 including retained
pure classifiers (`d1a771`). Added real composed callback test proves retired
endpoint404 for handled/completed, even with stale service option: no writer
call (`8b5a73`,7/7). Combined typed continuation/persisted C6 retirement81/81
(`e67acc`), with output truncation retained; expanded runner will save/read full
logs. Isolated missing-drain behavior mutant5/7 (`ae66f5`) fails both operation
and prepared-reservation teardown assertions, not a load error. Fingerprint proof
will be generated by the checkpoint's mutation lane.

Six index conflicts resolved108→102; census exactly matches Git paths (`92072f`).
The first census patch failed atomically because hunks were out of source order;
the corrected mechanical patch retained all other conflicts. Old disposition
and error-branch fixtures remain explicitly pending, not counted passing or deleted
to hide a failure. Public DispatchAdoptionAuthority's legacy queueCustody reads
are also pending canonical port; preserving its gate is not approval of those
reads. Final index/API/Web/Redis Message+Queue/pages remain open.

Prepared `/tmp/sol-a2a-1577-retired-owner-check-VcFSMp/run.mjs` uses nineteen
lanes: actual behavior mutation proof, fresh shared/finance/MCP and expanded
source/transport consumers,14 selected production semantics, format/directory,
62 input fingerprints and5 absent writer guards. It completed at
2026-10-07T05:36:42.189Z (managed wake570): nineteen lanes exit0,658/658,
fail/skip/cancel/todo0.62 fingerprints, frozen identities102, and five absent
writer guards unchanged. Fourteen production semantics0; format15 warnings,
directory threshold warnings retained. The mutation runner confirms5/7 with
two actual drain assertions failing and source hashes unchanged. All lane logs
read back; owned C6/F309 SQLite directories remain listed and retained.
Frozen identities remain unchanged, F202 remains e3efa166 only. No runtime,
config, user data, SDK auth retry, merge/restart or aggregate completion.

Source564 unread delta reports F202 Batch8 manifest fix and TREEba49a757,
eight-file successor of8b7f5b1. Notice only in this cut: source material and
51 hashes not independently rechecked here, no successor source consumed and
no code approval inferred. Full unread572 adds the exact patch hash
`94277752c3d8af5cbde728a8c58fc0f360d17235d0d79fd92181ae206be3ebc6`
and chain e3efa166→f60e12b→8b7f5b1→ba49a757. Coordinator reports artifact and
Settings evidence verified; this cut did not repeat Host verification or consume
the successor. Accepted F202 anchor remains e3efa166 until precise
semantic integration; final Host advisory/commit gates remain separate.

### C7 — actual Live completion contract seam, not mechanical type repair

Source-map and actual production-style F317 fixtures reveal an additional
boundary: public explicit_source separates full read from per-source work
completion using Ball disposition and old Message custody repair. Canonical
fork full read already retires pending delivery into response History. Retaining
public repair restores a second owner; replacing it with read=handled erases the
public missing-child/uncompleted-source safety property. Fresh four-file source
semantics exited1 with33 diagnostics (`31f9ef`); no production source changed.
Detailed anchors, recommendation and acceptance matrix are in
`2026-10-07-a2a-1577-live-completion-seam.md`. C7 goes to the existing coordinator,
not a new implementation or review task.102 conflicts and all aggregate gates
remain; current658 green cannot cover these newly inspected consumers.

### Twenty-second cut — C7 boundary and actual Live consumer migration

Coordinator source579 accepted carrier isolation and existing typed business
owner boundary. Explicitly retire the public untyped completion contract, not
its safety properties: full read is delivery only, outer success is not requested
work completion. Actual HTTP and compiled MCP now share exact returned-child and
Host close/drain checks; stale disposition hooks/advertisement are removed. The
affected index Live hunk is migrated but index remains unmerged/uncompiled.
Actual native Call transcript writers and canonical recovery visibility were
ported; existing privacy and credential lifecycle assertions preserved.

Red evidence lives in `/tmp/sol-a2a-1577-c7-red-CEBkvq`: child/gate8 failures,
processor2 failures, then a stronger post-commit-reply-loss assertion exposed
actual target resurrection. Both full-body and Append recovery now consult
persisted History, never local receipt flags. Unknown History preserves exact
claim; known committed target retires, sibling stays; pre-provider compensation
requires persisted exact admission. No model retry or business Task completion.
Final formatted targeted69/69; all earlier fixture/writer/rollback failures kept.
11-file formatting exits0 with55 warnings. Selected API/source tests are not final
API dist/index/Web/pages acceptance. C7 spec and consumer evidence record the
compatibility matrix, prepared fresh checkpoint and remaining old module types.

102 unresolved conflicts, frozen HEAD/MERGE_HEAD unchanged. F202 accepted input
still e3efa166; source590 advisory closure on successor70c793 is recorded but not
consumed or counted as formal approval. No runtime/config/user data, native/SDK
auth retry, merge/restart or aggregate completion. Fresh expanded checkpoint
`/tmp/sol-a2a-1577-c7-check-J1pPvo` must be read before claiming its result.

### Twenty-third cut — C7 checkpoint failure retained; orphan writer chain retired

J1pPvo read back failed:763/763 tests green and fresh shared/finance/MCP plus19
selected production semantics0; only inbox-test import sorting failed full
format. All20 logs/results retained.78 input hashes, identities102 and absent
hold writer guards unchanged. Safe import sorting applied; inbox10/10 and same
full format exit0 with70 warnings, not zero-warning or aggregate success.

After actual import/construction/writer/getter audit, remove five orphan C7
untyped completion/repair modules (authority/receipt/publisher/read-evidence/Live
adapter). No active producer consumes them after C7 port; old witness getter is
permission support for legacy Message custody, not canonical read projection.
Useful closing/drain and observation are kept. No storage deleted; exact source
blobs recoverable from frozen public Git. Absence/startup-hook guard actual RED,
then actual Live/HTTP/MCP/processor/native/recovery/inbox87/87. Old restart/private
port consumers and public obsolete completion fixtures remain explicitly pending.

Prepared20-lane fresh checkpoint `/tmp/sol-a2a-1577-c7-retired-check-EF0bKF`
preserves78 input fingerprints,10 absent writer guards and102 frozen conflicts.
Source600 returned its actual result:completed06:20:14.370Z,20 lanes exit0,
764/764 executions (HTTP/C7 overlap),78 hashes/10 absent guards unchanged,
19 selected production semantics0;70 format warnings retained. Not final index
or aggregate approval; original J1pPvo failed checkpoint remains intact.

### Twenty-fourth cut — C7 canonical startup replaces orphan custody recovery

Actual audit found six fork-deleted/public-modified recovery writers/types only
referencing their obsolete chain, plus one auto-added policy used solely there.
Remove StartupReconciler/MessageReconciler/QueueEntry/StartupTypes and
RestartTargets/RestartWitness plus queue-source-completion-policy. Canonical
QueueLedger hydration before listen, exact child recovery after listen, original
response settlement and alive/unknown child protection remain. Six index
conflicts resolved102→96; source recoverable from frozen public Git, no data
removed. Index itself remains unresolved and is not claimed built/accepted.

New actual Live close→child recovery→production response settlement→same-ledger
Queue hydration matrix covers running/succeeded child and settlement outage:
business Task stays todo, History-owned target never requeues, pending sibling
survives, stale callback rejects and repeat recovery has no new settlement/wake.
RED directory `/tmp/sol-a2a-1577-c7-startup-red-IdokA4`:4 cases3pass/1 absent-source
failure before removal (new behavior cases were already green); formatted
expanded targeted129/129 afterward. Startup-settlement omission mutant catches
one real assertion, plus three prior behavior mutants, source hashes unchanged.

New fresh20-lane checkpoint source606 returned actually completed06:31:52.909Z:
`/tmp/sol-a2a-1577-c7-restart-check-51eopY`787/787 executions (HTTP/C7 overlap),
82 hashes/17 absent guards unchanged,22 selected semantics0,73 format warnings.
Not aggregate approval. Remaining old untyped fixtures/private ports/
governance, F202 frozen successor consumption and final API/Web/index/Redis
Message+Queue/pages/hooks/formal review/human/soak remain. SDK auth not retried,
F202 input still e3efa166; runtime/config/user data untouched, no task300 close.

### Twenty-fifth cut — finish orphan private custody retry/direct-trigger owner cut

Frozen fork3f126bba7b deleted the direct trigger after producer unification.
Actual import/index/writer audit confirms public merge restores a separate direct
Invocation/Message-custody initialize-transfer owner. Remove its six-module
orphan chain: ConnectorInvokeTrigger, QueuedMessageCustodyCoordinator,
WaitContinuationRetryCommitter/Preflight, queued-message-custody private port,
A2ADispatchDispositionService. Source recoverable from public frozen Git; no
data removed. Six conflicts resolved96→90. Canonical exact lease legacy adoption,
atomic managed wake producer, independent post-commit notifier and Task/action
fences remain. Index only sheds obsolete import/options/construction; stillUU.

Structural guard1/1 RED before removal; formatted actual canonical connector,
legacy generation fence, post-commit drain failure and exactly-once, C5/C6
permission suites101/101. Evidence `/tmp/sol-a2a-1577-private-port-red-VUE1z9`.
Notifier-drain omission mutant fails a real assertion; four prior mutants remain
valid,7 input hashes unchanged. Public untyped/trigger/custody old fixtures are
explicitly pending, not erased or claimed compatible. Final index not accepted.

Expanded21-lane checkpoint actually failed, source612:781 pass/1 whole-file load
failure at `/tmp/sol-a2a-1577-private-port-check-o7mWNp`, completed06:41:13.758Z.
20 lanes exit0; deployment-callback exit1 due to remaining test import of deleted
WaitContinuationRetryPreflight. Whole lifecycle behavior file unexecuted, not one
failed behavior assertion.88 hashes/23 guards/frozen90 unchanged;25 semantics0,
format73 warnings. Production import scan did not cover all test consumers.
Original logs retained. Remaining fixtures/Redis guard/governance/F202
frozen-chain integration and final same-candidate API/Web/index/Redis Message+Queue/
page/hooks/review/human/soak remain. No SDK auth/native redo, runtime/config/user
data change, merge/restart or task300 closure.

### Twenty-sixth cut — restore real C5 test coverage, not an obsolete writer

Migrate f323-deployment-wait-lifecycle's original positive authority assertion to
retained DeploymentWaitStartGuard with actual Task/private receipt, Message and
fresh proof. Keep the file in the expanded runner and retain all existing
predicate/terminal/recovery/idempotency assertions. Add13 cases for scope/owner/
carrier identity, private snapshot revocation/generation/fence/outcome and actual
owner-transfer race; rejection performs no Task/Queue writes or new wake.
Four-file focused68/68 post-format; owner/generation/final-read omissions each
fail1 behavior assertion, plus existing5 mutants,10 hashes unchanged. No production
permission change, no restored writer, no fabricated product RED.

`/tmp/sol-a2a-1577-deployment-authority-fix-wgvhxL`21-lane fresh checkpoint actually
passed, completed06:53:42.423Z/source618:820/820 overlapping executions,90 inputs/
23 absent guards/frozen90 unchanged;27 selected semantics0, fresh three packages,
format74 warnings (56 files), C5 four files68/68. Eight valid behavior mutants.
Evidence/spec records source612 as failed, separate from this focused green.
Frozen90 conflicts remain; aggregate/index/API/Web/Redis Message+Queue/pages/hooks/
formal review/human/soak, old fixtures/governance/F202 and SDK still open.

### Twenty-seventh cut — retained canonical Task Redis boundary

Actual orphan RedisTypedWaitCustodyGuard imports already-removed old guard;
production+test scans locate only F323's direct test consumer. Remove the orphan
Message-custody Lua, resolve90→89; canonical RedisTaskStore/WATCH/private receipt
and TypedWaitContinuation retained. F323 original4 cases migrated, not excluded;
two real WATCH read-to-EXEC owner/generation race tests added. Exact fresh resolver
rejects wrong parent/source/scope/owner without writes; outcomes durable and CAS
winner owns its receipt. Old Queue-custody Redis tests still pending, not substituted
with mere read tests or claimed atomic Queue coverage.

Own Unix socket Redis (port0), no inherited runtime URLs/config, no key cleanup;
SAVE/shutdown exact child, RDB/AOF/logs/data kept. Evidence
`/tmp/sol-a2a-1577-redis-task-guard-bnZDWS`: original whole-file load failure and1
structural guard RED preserved; formatted91/91; exact-child/WATCH omission mutants
each fail1 expected behavior assertion and prior8 valid,14 fingerprints unchanged.
Fresh21-lane checkpoint completed07:05:33.356Z:827/827 execution counts (overlapping
scopes), all exit0;94 current hashes/24 absent guards/frozen IDs/89 conflicts unchanged,
31 selected production semantic diagnostics0, format77warnings and directory warnings.
Root2026-10-08 read back every lane and10 expected behavior-mutant failures; owned
Redis RDB/AOF/logs retained at paths in logs. F202 remains frozen e3efa166; aggregate/SDK/hooks/review/human/soak
not closed, no merge/restart or production data/runtime access.

Managed expanded checkpoint rejected429/3 holds, retryAt07:12:29.909Z, command
not started by that request. Foreground handoff621 actually completed green before
response622 and sol624 timed out; delivery timeout retained separately, not command
failure or formal review. No rerun of this completed checkpoint.

### Twenty-eighth cut — real Redis registration races and response-owned timeout details

Continued the interrupted source626 work in the sole same checkout. Both registration
suites now use retained owned Unix-socket Redis, without inherited REDIS_URL, cleanup,
flush or skips. Existing memory cases stay. New persisted final-proof cases reject
foreign child/source/scope/owner, changed generation/fence/predicate/baseline/outcome,
missing/corrupt receipts and expiry at the actual final read. Rejections do not repair
or overwrite winning Task hashes. Public hydration does not expose private receipts.

A deterministically scheduled concurrent registration exposed a real race: reading an
old Task then the winner's new managed binding threw TASK_MANAGED_WORK_BINDING_CONFLICT
before WATCH could reject the stale CAS. Read/watch the private binding before the
Task within the same exclusive WATCH session. Generation/revision, true existing
binding conflicts and owner/outcome restrictions remain. The load-time reverse-order
mutation reproduces the exact erroneous conflict (1 behavioral failure); production
source is never rewritten for that mutation. Original pre-restart red logs referenced
by source626 are not currently available in /tmp; the new replay is separate evidence,
not a replacement or claim to have reread those old raw files.

Screenshot source0001791423812144 shows one timeout represented three ways: settled
response text, a generic failure banner in its footer, and F118's folded diagnostics.
The response footer reused the entire standalone error card. Keep its retained timeout
payload but suppress that generic banner on response-owned timeout panels; expose the
folded evidence as 查看超时诊断. Standalone system error cards keep their banner, and
classified CLI causes/hints keep their actionable summary. No string matching, new
failure record, lifecycle/status/data mutation or runtime patch.

Architecture cell: chat response projection and Task registration aggregate.
Canonical source: RedisTaskStore#replaceAutomationStateIfGeneration; ChatMessage response
footer → TerminalDiagnosticsPanel → TimeoutDiagnosticsPanel. Consumer evidence: rerun
`rg -n 'TerminalDiagnosticsPanel|TimeoutDiagnosticsPanel' packages/web/src/components`
and `rg -n 'replaceAutomationStateIfGeneration' packages/api/src packages/api/test`.
Claim guard: reverse read order → the deterministic registration-winner assertion fails;
show the response-owned generic timeout banner → timeout component regression fails.
Standalone banner and classified CLI cause/hint tests guard preservation.

Evidence is now in checkout, not only temporary command directories:
`feature-specs/evidence/a2a-1577-2026-10-08-registration/`.
- Formatted source-loaded five-file registration/deployment set: 128/128; independent
  TaskStore/ball-custody consumers: 42/42. Initial 47 is a subset, not added to 128.
- Actual timeout/terminal/CLI component set: 19/19; duplicate-banner RED retained.
- Selected RedisTaskStore and two diagnostics production files: semantic/syntax0.
  Scoped format exit0 with6 preexisting accessibility warnings; diff check exit0.
- Actual ChatMessage router suite still fails to load: unresolved scrollToMessage.ts
  merge marker, zero tests executed. ChatMessage itself still has merge markers. This
  does NOT establish full response/page integration or a fresh compiled Web/API.
- Six owned Redis directories copied without deleting originals into retained-redis/;
  every retained RDB passes redis-check-rdb. AOF, keys and logs retained as synthetic
  evidence. Original loader invocation and mutant path errors retained separately.

HEAD/MERGE_HEAD stay frozen, 89 conflicts; F202 accepted source remains e3efa166.
Old typed-wait-queue-redis still calls removed commit/queueCustody/Lua machinery and
is not run or claimed green. Complete its semantic migration to actual canonical Queue
and Message composition, not another Task-only proxy. Web/index/build/hooks/SDK/
formal review/human/soak remain open. No merge, runtime config/data/process change,
PR publication, overall task300 closure or repeated 827-checkpoint claim.

Next independent checkpoint: verify the ten source hashes in results.json, run the
five-file source registration/deployment set plus TaskStore consumers using
`bash packages/api/scripts/with-test-home.sh node --import ./packages/api/node_modules/tsx/dist/loader.mjs --import ./scripts/a2a-1577-api-source-test-loader.mjs --test`
with the seven named files above; run Web's two standalone suites via its local Vitest;
run registration-order-mutant.mjs with --test-name-pattern='winner between Task snapshot'
and require exactly1 binding-conflict failure. Inspect the actual footer wiring and
retain the whole-router load blocker. This is scoped independent verification, not
APPROVE of the aggregate or task completion. Sole writer stops edits during the run.

Exact scoped independent commands (run foreground in the sole checkout, keep
new output separate from author logs):

```sh
bash packages/api/scripts/with-test-home.sh node --import ./packages/api/node_modules/tsx/dist/loader.mjs --import ./scripts/a2a-1577-api-source-test-loader.mjs --test packages/api/test/1392-registration-atomicity.test.js packages/api/test/typed-wait-registration-redis.test.js packages/api/test/typed-wait-registration.test.js packages/api/test/f323-deployment-wait-redis.test.js packages/api/test/f323-deployment-wait-lifecycle.test.js packages/api/test/task-store.test.js packages/api/test/ball-custody-task-store.test.js
bash packages/api/scripts/with-test-home.sh pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/ChatMessage-timeout-diagnostics.test.ts src/components/__tests__/CliDiagnosticsPanel.test.ts
bash packages/api/scripts/with-test-home.sh node --import ./packages/api/node_modules/tsx/dist/loader.mjs --import ./scripts/a2a-1577-api-source-test-loader.mjs --import ./feature-specs/evidence/a2a-1577-2026-10-08-registration/registration-order-mutant.mjs --test --test-name-pattern='winner between Task snapshot' packages/api/test/1392-registration-atomicity.test.js
```

The last command MUST exit1 with exactly1 real binding-conflict failure; loading
or syntax errors are not successful mutation evidence. The first two must exit0.
No compiler/API/production-page or account/provider verification is implied.

### Twenty-ninth cut — native Redis Queue/History fixture and real response rendering

Source008 independently verified cut28's 170 API/19 component cases and the real
binding-order mutant; the sole writer resumed only after that return. Cut27's 827
checks had already completed; the later invocation timeout was result delivery,
not command failure. Those old counts/hashes are not repurposed for this cut.

The old typed Queue test is migrated in place to real `RedisMessageStore`,
`RedisQueueLedgerStore`, `InvocationQueue`, `InvocationTracker` and the native
`QueueProcessor.onLifecycleInvocationStarted` seam. Its controlled router calls
that real admission callback, then the actual private Task routing-exit resolver,
then commits/settles a durable response. It does not invoke a real provider or
claim the whole route-serial strategy has been exercised by this fixture.

Architecture/authority evidence:
- Queue pending targets remain owned by QueueLedger. Response + source dispatchRef
  are persisted before the actual Queue Lua retires the exact target; the ledger
  is absent before controlled provider execution and remains absent after a cold
  Queue hydrate. History carries the settled source→response relation.
- A private typed Task receipt grants only the exact child/source routing exit.
  Matched outcome, expiry, supersession, owner drift, missing proof and read failure
  reject that exit. These transitions do not undo already persisted delivery or
  complete/repair the business Task; it remains todo and persistent (TTL -1).
- Six ordinary cases plus bounded/persistent five-race matrices are 16 tests.
  Collector-only updates preserve the private registration; losing CAS preserves
  the winner's exact child. The expiry assertion is a current resolver-clock check,
  not the retired server-time Task/Message Lua coupling.
- Prior `h.commit`, `queueCustody`, `waitGuards` and falseBypass-telemetry assertions
  represented the retired owner. Their premigration 16-failure log is retained as
  **fixture incompatibility**, not a newly discovered production bug. No old
  coordinator, Lua authority or metrics proxy was restored just to make it green.

Web semantically combines the new shell/nameplate/companion/publication presentation
with fork lifecycle response renderability, canonical timestamps, exact reply preview,
ActiveRun/dispatch avatars, append receipts, routing warnings and diagnostics selection.
The same shared Hold cancel entry/button is retained with Host/development-return
headlines and publication coordinates; the inline public duplicate is removed.
Scroll combines paragraph/fingerprint anchors with the public browser-clamp retry
condition and retains the shared jump marker. No MessageReceiptDock/old Queue receipt
owner was reintroduced in ChatMessage. Unused optimistic-ID rekey helpers are not
retained in chatStore: canonical stored identity still owns rows.

Type checking caught a mistaken public freshness-supplement port. Actual shared
`freshness-closure.ts` documents #1398's retired scan protocol and contains only
`priorFrontierMessageId`. The incompatible function/fields/render were removed;
the existing notice regression confirms no fabricated scan/supplement status is shown.

The screenshot's timeout panel is now verified through real `ChatMessage`, including
CLI precedence, standalone system error preservation, response-owned folded diagnostics
and duplicate suppression. A second actual bug found while composing the page:
`projectCloudBindingRecovery`'s exact sent/failed Host fact was not passed to its card.
The new real ChatMessage/Card test was RED (2 failed/1 passed), then GREEN3 after passing
deliveryStatus. It proves a terminal exact dispatch neither reopens a recovery probe
nor borrows another dispatch's terminal fact. Failed Host transport receipts are
projected without a generic retry attempt, using the exact source/target/dispatch
receipt rather than obsolete Queue attempts. Bounded recovery polling stops on
terminal facts and keeps its existing identity/generation fence.

Post-format author evidence in
`feature-specs/evidence/a2a-1577-2026-10-08-queue/`:
- Eight source-loaded API files: **186/186**, no skip (prior170 plus new16; earlier
  subset executions are not added). Actual owned Unix Redis Queue + Message + Task.
- Twenty-one Web suites: **188/188**, no skip. Includes actual response router32,
  timeout/CLI panels19, shell/human/nameplate, native dispatch22, append projections,
  recovery wire3, connector/hold, shared scroll17, notice13 and store/hook consumers.
  This is component/router verification, not a built page/browser/human acceptance.
- Three load-time-only mutations each exit1 with exactly1 real assertion failure:
  omitted dispatchRef, omitted native target retirement, and false routing-authority
  grant. No product source mutation persists. Initial module-path/thread-argument
  harness errors remain separately named; they are not behavior RED evidence.
- Eleven selected Web source/test files have zero local diagnostics. **Seven dependency
  diagnostics remain**, so this is not a full Web type/build gate. Scoped formatter
  exits0 with33 warnings; selected staged/unstaged diff checks exit0.
- All11 owned Redis directories remain in their original paths and are additionally
  copied as RDB/AOF/logs into retained-redis. Each redis-check-rdb exits0, sockets
  are gone after normal SAVE shutdown, hashes are in results.json. No flush/delete,
  inherited Redis service, runtime user data/config/provider or process was touched.
- Twelve index conflicts are staged resolved; **77 remain**. Frozen HEAD and
  MERGE_HEAD are unchanged. This is not a legal completed merge commit.

Retained larger-scope blockers (do not count these tests as passing): legacy
`cloud-host-retry.test.tsx` still fails to load through the unresolved retired
MessageReceiptDock chain. `bubble-publication-provenance.test.ts` cannot load the
old `debug/bubbleIdentity` import in bubble-projection. The remaining hook/store/page
migration must preserve publication origins at canonical stored-message boundaries;
do not revive the retired debug/bubble owner to clear a test.

Task300's final predicate is now explicit from coordinator source021 and the
operator T0 anchor it supplied:
`thread_mrkn6povq4zzgh45#0001791424629052-000011-3b585e95`.
The fork candidate must actually consume immutable F202
`e3efa166→f60e12b2→8b7f5b1→ba49a757→70c79391` semantics, retaining C1–C7 and
QueueLedger/exact-child authority: one production createCloudConversationComposition
factory, Batch8 package pins, generic rows action labels and subsequent feedback
fixes. **Still unconsumed in this cut**; the 122-path byte census is an index of
differences, not 122 proved defects. A legal exact commit, same-candidate clean gates
and source/semantic mapping are required before announcing operator acceptance readiness.
Formal independent review, operator human acceptance/soak and SDK proof remain open.

Public F202 candidate belongs to the Host thread/public chain. Coordinator's current
gh evidence reports #1487 still draft/conflicting at b0fe0e9d; do not push this fork
aggregate to feat/f202-c1-core-cutover. Public owner derives from its lawful public
baseline and receives only an exact public-safe delta if needed. No merge, restart,
force-push, public submission or task300 closure is claimed by this cut.

Next independent foreground checkpoint (sole writer pauses edits during the run):

```sh
A2A_VERIFICATION_DIR="$PWD/feature-specs/evidence/a2a-1577-2026-10-08-queue/astra-independent-20261008" node feature-specs/evidence/a2a-1577-2026-10-08-queue/independent-run.mjs
```

The script names the exact 8 API/21 Web/3 mutant commands, refuses reused evidence
directories, checks all28 source hashes + HEAD/MERGE_HEAD/77-conflict list before
and after every lane, requires186/188 pass and each expected1 assertion failure.
Read the full new logs/results, independently retain the newly owned Redis data,
and optionally rerun selected-web-types.mjs while preserving its honest dependency
diagnostic boundary. This is scoped verification, not aggregate APPROVE or a new task.
After return, continue remaining native Queue fixture/governance, Web hooks/store/page,
index/provider conflicts and actual frozen F202 successor consumption in this checkout.

## CUT30 — canonical Web/History/Queue consumers (2026-10-08)

Sole writer resumed only after astra source037 returned CUT29 independent results.
Those results remain 186 API / 188 Web, not added to this cut's counts. No API source
or owned Redis directory changed here: twelve API/loader inputs still match the
CUT29 independent hashes. This cut runs Web only and creates no Redis instance.

Resolved and staged eleven conflict paths, reducing 77 to **66**. HEAD remains
`db3fbbce7b9b98fe5d6b34c44016d03075fb6f17`, MERGE_HEAD remains
`3e70e1d6805be24672e8f841861f180d20b184c2`. There is still no legal candidate commit.

- `useAgentMessages` keeps the canonical active/background named-message writers;
  the public client bubble reducer is not restored. `useSendMessage` admits a Queue
  input without a speculative History record; its media publication arrives from
  the stored lifecycle snapshot, with its exact messageId/URL/revision.
- `useChatHistory` retains both deliberate disclosure anchors and the public rail
  gesture lifecycle. All reading geometry uses the durable browser-local owner,
  including admission/reorder corrections; the removed module Map is not recreated.
  Cold `extra` normalization shares the existing exhaustive typed merge rules,
  preserving pending custody offers and exact cloud retry provenance while dropping
  retired Queue receipt fields. Metadata diagnostic copies remain a fallback for
  their corresponding typed message carrier.
- Scroll memory resolves exact persisted IDs, never another record sharing a child
  invocation. The paragraph index/fingerprint/signed offset survives a cold page.
- `ChatMessageRow` uses `activeRuns`, preserving public sendContext/confirmation props.
  Queue slot hydration retains both ActiveRun and settlement projections. Carrier
  presentation consumes the shared four-field capability parser; precision and the
  ability to guide an active invocation remain separate facts.
- `useSocket` ports the artifact-review and modification-source refresh events and
  removes their own listeners on unmount. Queue refresh waits for authoritative
  `/queue`; lifecycle events alone publish History delivery/read evidence.
- `QueuePanel`, `QueueEntryRow` and Steer convergence retain canonical sender,
  source refs and per-target actions. Public Host return headlines/display names
  are consumed from `MessageFrom.external.connectorId`; no legacy receipt or
  force-reset authority is restored. F322's old execution-row convergence consumers
  still need migration and are not claimed passing.
- Removed dead DU `bubble-projection.ts` after migrating its two remaining test
  consumers to real stored-snapshot writers. Publication tests now verify distinct
  same-invocation message IDs and original item coordinates through real entry UI.

Evidence: `feature-specs/evidence/a2a-1577-2026-10-08-history/`.
Author's exact five-lane run completed 02:54:00.844Z–02:54:14.235Z:
22 suites **220/220**, then three load-time behavior mutants each expected exit1
with one AssertionError (cold carrier loss, wrong paragraph index, omitted socket
listener retirement). The normal run has no failed/skipped tests; mutation filters
deliberately skip other cases. Eighteen selected source/test files have zero local
type diagnostics/config errors; seven dependency diagnostics remain in the retired
turn-absorption owner. This is not full Web tsc or browser/page acceptance.
Forty source hashes and HEAD/MERGE_HEAD/66-path conflict list stay fixed per lane.
Browserslist and React act warnings remain in original logs.

Initial conflict/import/runtime failures and actual RED assertions are retained;
the former are not called mutation kills. `bubble-publication-provenance` and the
real publication-entry suites now execute successfully; `cloud-host-retry` is not
re-executed or claimed passing. Screenshot diagnostics still pass the real 32-case
ChatMessage suite. No candidate has been deployed into the running instance.

F202 clarification from actual source inspection is in
`f202-consumption-boundary.json`: all five immutable identifiers are **trees**,
not newly submitted commits. Even e3efa's declared cloud registry and plugin return
poller are absent here; index still starts the PersonalChrome adapter/poller and
runtime still uses the old hybrid supervisor. The shared production factory,
Batch8 pin helper and generic rows renderer are also absent. Previously registered
source provenance is not proof of a fully consumed F202 base. Resolve the base
declared/carrier/runtime seams before the successor factory; preserve fork
QueueLedger/exact-child/C1–C7. Never overwrite the plugin package wholesale.

The task300 fork exact commit + same-candidate clean gate + full semantic mapping
predicate and the separate public Host ownership remain unchanged. Provider/index,
remaining Web/page/hooks/governance fixtures, formal review/SDK/human/soak remain
open; no merge, restart, force-push or public branch submission is authorized here.

Next independent foreground verification (sole writer pauses source edits):

```sh
A2A_VERIFICATION_DIR="$PWD/feature-specs/evidence/a2a-1577-2026-10-08-history/astra-independent-20261008" node feature-specs/evidence/a2a-1577-2026-10-08-history/independent-run.mjs
```

Read the new lane results and assertion summaries, check unchanged fingerprints and
the honest selected-type dependency boundary. This is continued task300 validation,
not a new implementation task, aggregate APPROVE or a completed lifecycle claim.
# Current task300 boundary — operator 2026-10-08 delivery closure

This section supersedes the historical completion predicates below where they require full F202 frozen-chain consumption or Phase M model-read tracking. Authority: thread_msr51149hym0i79f operator messages 0001791431589436-000016-027ee9e2 and 0001791433389141-000027-28bf60b3, coordinator 017/026/028. Sole writer and original task300 remain unchanged.

The candidate must implement one pending Queue → member delivery → canonical response outcome mechanism. Remove the model-read/awaiting-read queue and the five-minute client-created invocation-status History notices. Reconnect verifies the existing response/ActiveRun; an unavailable snapshot is unknown, not terminal. Failure diagnostics belong to that response and are folded; standalone admission failure retains its one outcome. Preserve exact source×target undelivered failure compensation and human artifact feedback as idempotent business input, without an extra A2A completion protocol.

F202 is independent. Only real unified delivery/callback/startup interface intersections belong to this A2A candidate; accepting a frozen source does not establish semantic consumption. Historical F202 acceptance evidence remains historical, and full registry/Settings/package-pin implementation is no longer an A2A prerequisite. Quotes and long text are limited to already implemented small, reasonable accompanying fixes.

Deliver meaningful A2A commits and a clean public-source candidate for #1398 against current upstream main, separately map fork-only sources, validate that same candidate and its fork integration, then obtain independent review and operator experience/soak. No runtime restart, force push, or upstream merge is authorized. Current partial checks are not full API/Web build, browser, deployment, or aggregate approval.

The in-progress implementation checkpoint and original RED/load failures are retained at `feature-specs/evidence/a2a-1398-2026-10-08-delivery-closure/`. Its source hashes describe only that capture, not later inputs.
