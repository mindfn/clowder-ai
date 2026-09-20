---
title: "Cross-Thread Protocol — RFC (DRAFT)"
doc_kind: architecture
feature_ids: []
related_features: [F052, F128, F167, F193, F246, F306]
topics: [cross-thread, thread-boundary, thread-relation, addressing, rfc]
created: 2026-09-20
updated: 2026-09-20
status: draft
author: "opus"
description: "跨 thread 协作的边界协议 RFC：先定义 thread 边界与跨越边界的三类目的，再由目的长出关系图、工具与机械约束；Review 只是工作分解的一个例子，不是顶层规则。"
description_source: human
description_author: opus
description_updated_at: 2026-09-20T05:00:00Z
---

# Cross-Thread Protocol — RFC (**SUPERSEDED — gating model rejected**)

> ⛔ **The authorization model in this document was rejected by upstream maintainers on 2026-09-20**
> ([`zts212653/clowder-ai#1490`](https://github.com/zts212653/clowder-ai/issues/1490), correction
> superseding the earlier triage). **Do not implement any part of it as a gate.**
>
> **Rejected:** an active `ThreadRelation` as a prerequisite for ordinary cross-thread delivery ·
> staged enforcement of a relation allowlist · replacing or deprecating `cross_post_message` with a
> relation-gated send · removing source-selected `targetCats`.
>
> **Why — and it is decisive.** Precedent: `cat-cafe#4255`, *"retire local review custody"*
> (merged 2026-09-03, ~8,088 lines removed). Local review delivery previously had **this same
> architecture at narrower scope** — lease, generation, replacement, issuer-route authority,
> reentry, verdict settlement, recovery. In a real review, a reviewer who had already completed the
> exact-HEAD review and produced three blocking findings **could not deliver them**, failing through
> `local_review_verdict_identity_unavailable → lease_not_active → replacement/generation →
> issuer-route authority`. Work resumed only when the findings were sent as an ordinary typed A2A
> message. The fix was **subtraction**, not refinement.
>
> **Verification status (honest).** That PR is **not verifiable from here** — `zts212653/cat-cafe`
> does not resolve for this account. The *substance* is corroborated in our own tree:
> `lease_not_active` appears across **17 source files**,
> `local_review_verdict_identity_unavailable` exists, and three `Legacy*LocalReview*` shims remain —
> the shape a retirement leaves behind. It is also corroborated first-hand: while closing out this
> very RFC, **both structured completion producers rejected with 409**
> (`managed_hold_disposition_source_mismatch`, `a2a_dispatch_disposition_source_missing`) and the
> author could not dispose of his own ball through the structured path.
>
> **The self-refutation.** This RFC's `escalation` purpose is the one most needed when things are
> broken — and under a relation gate it is the one most likely to be blocked, because a cat that is
> stuck is exactly the cat that may lack an accepted relation.
> *Making a mistake inexpressible also makes the needed message inexpressible.*
>
> **The invariant that survives, and that this document violated:**
>
> > **Automation failure must degrade automation. It must not freeze communication.**
>
> **What remains acceptable — strictly non-blocking:** relation data for observability,
> recommendations, provenance display and misdelivery *warnings*; and emitting a **structured
> child/parent reference** instead of a raw call template, *provided that reference never becomes a
> delivery credential*. Any follow-up must make **non-gating an invariant**, not a phase before
> enforcement.
>
> Retained as an investigation record. **§1–6 (boundary, purposes, counter-examples, the four
> questions) stand. §7–10 (relation-as-authority, the three-verb tool surface, migration) are
> rejected.**


> **Status: DRAFT for review.** Nothing here is built.
> Companion: [`a2a-protocol.md`](./a2a-protocol.md) — the message lifecycle *inside* one thread.

> **What this protocol is.** Not a message routing protocol, and not a server-side workflow.
> **It is the boundary protocol between independent agent work contexts.**

### Revision history — two coordinate-system corrections

| | What it got wrong | Correction |
|---|---|---|
| **v1** | Five persistent objects (`Coordination`/`Participation`/`Invitation`/`Delivery` + lease) and four commands | Server-side workflow orchestration. In a client-side agent app the **agent** understands the collaboration; the server only stops it escaping a confirmed relationship. |
| **v2** | Led with `ThreadRelation`; stated *"review does not cross threads"* as a top-level rule | Still reasoning **backwards from action names to architecture**. Review is not the criterion — **whether the contexts are independent** is. |

Both corrections came from the operator. Recording them because the pattern matters more than the
outcome: twice I reached for structure before defining purpose.

## Motivation

Six operator-confirmed misdeliveries across eleven threads, 2026-04-30 → 2026-09-19
(`docs/bug-report/ghost-thread-cross-thread-session-routing/`). The server never mis-bound a thread
in any of them — it delivered exactly where it was asked to. **The asking is what has no design.**

> **The defect, precisely.** For ordinary cross-post and PR-review initial handoff: when the system
> cannot resolve an independently authorized endpoint, the API still accepts any scope-valid
> `threadId` and produces messages, wakes and custody side effects — and the caller has **no
> legitimate unknown-target / proposal-only exit.**

---

## 1. What a thread boundary is

A thread is **one independent work context**:

- its own **goal** (F306, `ThreadStore.ts:206`)
- its own history and memory
- its own cats and execution queue
- its own task state and final artifacts

The boundary is not organizational, and it is not about who is present. It is about **whether the
goal, memory and execution state are meant to stay separate.**

## 2. Why cross it at all

> **Crossing a thread boundary lets two work contexts that remain independent exchange the
> information, responsibility or results that a real dependency requires — without mixing their
> goals, memory or execution state.**

It is **not**:

- a way to find a particular cat;
- justified by "the reviewer happens to be in another thread";
- copying a message somewhere recently seen;
- general-purpose remote scheduling;
- another way to send ordinary chat.

If two things belong to the **same goal**, they must not cross a boundary merely because the role
changed. If they are genuinely **two independent goals**, an activity named "review" may perfectly
well cross one.

## 3. The three purposes

### 3.1 Work decomposition — hand an independent sub-problem to another context

```text
A: implementing a feature
└─ B: independent compatibility investigation / security validation / review experiment
```

A → B carries: **the problem**, **the necessary context**, **acceptance criteria**, **the return
path**. B keeps its own goal, context and execution state; the result comes back to A.

> Review that needs an isolated investigation environment belongs **here** — because it has become
> an independent sub-problem, **not because the activity is called review**.

> **This purpose does not have a send verb.** A new work context can only be created by
> `cat_cafe_propose_thread`: on operator approval the child thread, the `parent_child` relation and
> the goal / initial-message **seed** are established atomically — or committed recoverably. There
> is **no `handoff` purpose on the generic send tool** — see §8.
>
> An earlier draft said "the initial **task**". Withdrawn: the approval path persists a child plus a
> proposal **seed** and creates no `Task` (`proposal-routes.ts:82-84`; no `createTask` on that
> path). Requiring one would have smuggled a server-side workflow object in through the RFC.
>
> If an *already independent* thread needs further decomposition, **it creates its own child**. The
> source never reaches across a boundary to create work on the other side.

### 3.2 Dependency coordination — two independent workflows must stay consistent

```text
A: changing a Core API
B: building Plugins
C: building Console
```

A tells B and C the **impact fact**, negotiates interface or timing, and waits for confirmation.
Each then acts **inside its own thread**. A does not take over B's or C's custody and does not
create tasks inside them.

### 3.3 Report and escalation — return results to the context holding overall responsibility

```text
child / feature thread
└─ result · milestone · blocker · decision-needed ──► parent / project / owner thread
```

This is a closed loop along an explicit responsibility relation — **not** treating MAIN as a public
inbox. Incident I-4 is exactly the failure of having no such distinction.

## 4. When *not* to cross — counter-examples

| Situation | Why it stays in one thread |
|---|---|
| Reviewer is a different cat, same feature, same goal | Role switch inside one context. Wake the reviewer **here**. |
| "I need X's opinion" | Wanting a cat is not a dependency between contexts. |
| Status update with no dependency and no responsibility loop | Noise. It belongs in its own thread, or nowhere. |
| Source wants the target to execute a specific step it has already decided | That is remote manipulation — workflow stuffed into a message (see Q4 below). |
| The target thread was simply the last id in view | Not a reason. Not even a bad reason — no reason at all. |

## 5. The four questions

1. Do source and target have **different goals / contexts**?
2. Is there a **sub-task, dependency, or responsibility loop** that must synchronise across the
   boundary?
3. **Why this target thread** — can the metadata / relation graph explain it?
4. After receiving, does the target **act independently in its own context**, or is it being
   **remotely manipulated** by the source?

- **(1) or (2) fails** → stay in the current thread.
- **(3) unanswerable** → discovery and proposal only; no delivery.
- **(4) is remote manipulation** → workflow has been stuffed into a message; redesign the call.

## 6. Discovery is not a fourth kind of delivery

When "who owns X" is unknown, the legal sequence is:

```text
search  →  inspect candidates (goal / metadata / relation graph)  →  propose relation  →  accept  →  delivery
```

A relation proposal may surface in a lightweight Needs-Me / relation management surface. It must
**not**: inject business content · wake execution · transfer custody · push the source's context
into a candidate thread.

This is where candidate selection happens — **once**, and a wrong guess costs only a rejectable
proposal.

## 7. The relation graph — grown from the purposes

Relation types are not invented; each is the durable form of one purpose.

| Purpose | Relation type | Permitted message purposes |
|---|---|---|
| Work decomposition | `parent_child` | `result`, `status_report` (creation goes through `propose_thread`, not a send) |
| Dependency coordination | `peer` (undirected) / `depends_on` (directed) | `dependency_update`, `status_report` |
| Report and escalation | `reports_to` | `result`, `status_report`, `escalation` |

`left`/`right` cannot express direction, so the server could not tell which side may send a
`result`, which side an `escalation` targets, or who the reporter is. The relation is therefore a
**tagged union with semantic field names**:

```ts
type ThreadRelation = { id; status: "proposed" | "active" | "closed"; reason; provenance } & (
  | { kind: "parent_child"; parentThreadId:    string; childThreadId:      string }
  | { kind: "depends_on";   dependentThreadId: string; dependencyThreadId: string }
  | { kind: "peer";         threadIds: readonly [string, string] }          // undirected
  | { kind: "reports_to";   reporterThreadId:  string; ownerThreadId:      string }
)
```

`parent_child` / `subtask_of` is resolved to **one** name: `parent_child`. "Subtask" is a *reason*
for creating the relation, not a separate kind — an MCP `kind` enum must have exactly one
authoritative meaning per value.

It is simultaneously the **graph edge** and the **authorization to deliver**. An "invitation" is a
`proposed` relation; accepting makes it `active`.

**Not created:** `Coordination`, `Participation`, `Invitation`, `Delivery`. What v1 called a
coordination is the *process* that relations and messages form dynamically — it does not need a
server-side aggregate root. The existing lease keeps meaning only **who holds the ball**.

> **Permitted purposes derive from `type`.** v2 put an `allowedIntents` field on the instance; that
> is a second source of truth for something the type already determines. Removed.

## 8. Tools and mechanical constraints

A message carries **the purpose of this boundary crossing** — not a generic action name:

```ts
cat_cafe_propose_thread_relation({
  candidateThreadId,
  kind: "peer" | "depends_on" | "reports_to",
  reason,
  clientRequestId,
})
// -> { relationId, status: "proposed" }
// posts no message, wakes nothing, creates no custody

cat_cafe_respond_thread_relation({
  relationId,
  decision: "accept" | "reject",
  reason?,
  clientRequestId,
})
// -> canonical relation status
// the responder identity (target thread, or operator) is derived server-side

cat_cafe_cross_thread_send({
  relationId,                 // never a threadId
  purpose: "dependency_update" | "result" | "status_report" | "escalation",
  content,
  replyTo?,
  clientMessageId,
})
// -> { messageId, relationId, derivedTargetThreadId, deliveryState, attentionState }
```

Every write verb takes an explicit idempotency key and returns a real receipt — no verb reports
completion from "it was written".

> **`replyTo` must be validated against the relation-derived target thread.** Otherwise it becomes a
> second addressing channel and reintroduces the exact defect this protocol removes.

> **No `targetCats`.** v2 kept it; removed here. The relation authorizes a *context*, and the
> receiving thread routes internally. Letting the source name the acting cat is precisely the
> remote manipulation question 4 rules out. The relation **is** the routing credential.

### The attention contract (maintainer gap #2)

Removing `targetCats` answered *where delivery may go* but left *which participant wakes*
unanswered — a real hole, raised in maintainer triage of `zts212653/clowder-ai#1490`. The resolving
principle:

> **The receiving context owns its own attention routing.**

- The relation carries a **target-side handler**, designated **by the target at accept time** and
  changeable unilaterally by the target thereafter. The source never sets or sees it as an input.
- **No handler designated → no silent wake.** The message lands as a Needs-Me item in the target
  thread that any participant may claim. Waking an arbitrary cat because a thread has several is
  not a fallback; it is the defect in miniature.
- `escalation` keeps its `pending_ack` semantics on top of this: unacknowledged is not done.

This preserves "the source does not name the acting cat" while making target-side wake-up a
defined, owned behavior rather than an omission.
>
> **No `handoff`.** v3 first draft kept it, which would have smuggled remote custody transfer back
> into a message parameter. This is the mechanical answer to question 4:
>
> > **Only `propose_thread` can create a new work context. `cross_thread_send` can never create or
> > transfer custody on the target side.**
>
> Prose can still *sound* like an order and no server can fully detect that — but a structured
> workflow can no longer hide inside the parameters.

### Structured custody transfer keeps its own carrier (maintainer gap #3)

"Messages do not transfer custody" is necessary but not sufficient: an **independently authorized**
successor action across a boundary is a legitimate need, and deleting `handoff` without naming its
replacement left that need homeless.

> **A relation authorizes *where*. Custody admission requires its *own* authorization on top.**
> They are never the same grant.

- The generic send **never** carries custody. Unchanged.
- A structured cross-boundary successor action uses a **separate, explicit carrier** with **atomic
  custody admission** — one durable cutover, or nothing.
- Today's shape is already close: `action` / `proposedAction` with Approval Hub gating for
  `assign_work`. The change is to make that carrier **relation-bound instead of `threadId`-bound**,
  **not** to fold it into `cross_thread_send`.
- Being a relation participant does **not** by itself make one eligible to receive custody.

The server enforces mechanics only, with no business knowledge:

- source thread derived from the invocation — it cannot be forged;
- a send **must** reference an `active` relation;
- the target is derived from the relation; a bare `threadId` is not accepted;
- `type` constrains which `purpose` values are legal;
- replies travel back along the originating relation;
- the `parent_child` edge is committed **atomically** with child creation;
- a relation *proposal* carries no work ball and no content side effects;
- agent-key callers cannot bypass a relation to supply a thread directly;
- thread metadata exposes `goal` and the relation graph.

**What stays with the agent:** whether a real dependency exists · which purpose applies · what the
content is · whether to close a relation · what the receiving cat should do locally. These are
judgements. Freezing them into server-side workflow was v1's mistake.

## 8b. What this changes in the existing MCP surface

This is the concrete question, and v3's first draft did not answer it. Code references below were
read from source; rows without one are proposals, not findings.

| Tool today | Change |
|---|---|
| `cat_cafe_post_message` · `multi_mention` · A2A disposition | **Keep as-is.** They are *intra*-thread: collaboration, lease, review, custody inside one context. This protocol does not touch them. |
| `cat_cafe_propose_thread` | Already carries `parentThreadId` and resolves it at approve time (`proposal-routes.ts:20`, `proposal-approve-overrides.ts:54`). Change: emit a **`relationId`**, so that child + `parent_child` relation + goal/initial-message **seed** are created through one atomic or recoverably coordinated approval transition. (No `Task`: the approval path creates none — `proposal-routes.ts:82-84`.) |
| **`proposal-enrich-header.ts`** | **The sharpest single fix.** At the exact moment a `parent_child` edge is born, it injects a raw call template into the child's header: `` `cat_cafe_cross_post_message(threadId: "…", targetCats: […])` `` (`:57-58`). The relation is *known for certain* here, and we hand the child a string to copy instead. Replace with the `relationId`. |
| `cat_cafe_cross_post_message` | Mark **legacy**. Today one tool carries `threadId` + `targetCats` + `action` + `proposedAction` + `localReviewVerdict` + `coordination` + `effectClass`. That bundle is the defect in tool form. Unbundle in the order below — never remove a capability before its replacement path exists. |
| `cat_cafe_cross_thread_send` | **New.** `relationId` + `purpose` + `content` + `clientMessageId` (+ `replyTo`). No `threadId`, no `targetCats`, no custody fields. |
| `cat_cafe_propose_thread_relation` | **New.** Proposes `peer` / `depends_on` / `reports_to` between *existing* contexts. Carries no body, wakes nothing, transfers no custody. |
| `cat_cafe_respond_thread_relation` | **New.** Accept/reject — only from the target thread's own invocation, or the operator. |
| `cat_cafe_list_threads` | Enrich with `goal`, feature, metadata, relations, `whyMatched`. Its output is **candidate evidence, never delivery authorization** — the description must say so. |
| `cat_cafe_feat_index` | Keep as discovery. Description must state plainly that a `threadId` it returns **is not a routing credential**. |
| `cat_cafe_get_thread_metadata` | Add a **read-only** relation projection. |
| `cat_cafe_set_thread_metadata` | **Must not** edit relations. Relations change only via creation or propose/accept/close. |
| Backlog dispatch gate | Gates on `dispatchedThreadId` (`RedisBacklogStore.ts:338,369`). Should gate on relation/proposal state instead. |
| `DispatchProposal` | Persists caller-supplied `targetThreadId` (`DispatchActionApprovalService.ts:79`) in the entity and its canonical key — so its **approval lifecycle and UI are reusable, its addressing payload is not**. |
| PR / Issue tracking | Description must state it is a **notification subscription only** — never a review holder or endpoint authority. |

### Legacy unbundling order

"Unbundle, then restrict" was not executable. The order, chosen so that **every step leaves a
working replacement path**:

1. Add the relation store / projection and the **opt-in** send. Change no existing behavior.
2. Switch `propose_thread` to the relation return route; **stop emitting raw address templates**.
3. Give the new path target-side internal routing; drop source-supplied `targetCats`.
4. Split the most dangerous structured side effects out of legacy cross-post:
   `action`, `proposedAction`, `localReviewVerdict`.
5. Replace `effectClass` with the typed `purpose`; `coordination` degrades to compatibility
   provenance and **grants no authority**.
6. Once coverage and ambiguity data clear their thresholds, restrict raw `threadId`.
7. Only then remove the legacy tool.

### Surfaces that must migrate in the same wave

Otherwise the old and new protocols teach cats simultaneously:

- `proposal-enrich-header.ts` (above)
- recent-tools / cross-post suggestion surfaces
- the `cross-thread-sync` skill
- prompt hooks that hand out raw `threadId` + `targetCats`
- governance tests and **every tool description that still teaches thread-addressing**

> The tool surface is where the model is actually taught. Shipping the objects without the
> descriptions would leave the lesson unchanged.

## 9. What exists today — Verified

| Path | Constraint today |
|---|---|
| Ordinary cross-post | existence + principal scope only (`callback-scope-helpers.ts:92-122`) |
| task/implement first handoff | **already validated** against `task.threadId` (`ActionSubjectTruthResolver.ts:292`) |
| PR/review first handoff | freshness returns no thread → the `target_thread` check silently no-ops |
| local review terminal return | **already forced** back to the predecessor thread |

`Thread.parentThreadId` / `sourceThreadId` (`ThreadStore.ts:238-240`), `getChildThreads()` (`:834`)
and `Thread.goal` (`:206`) all exist; lineage is present on **29/531 threads (5.5%)** and **no
delivery path reads any of it**. `ActionSuccessorLease` is one execution edge
(`action-successor-state-machine.ts:90-99`), not a relationship graph.

## 10. Migration

1. **Non-enforcing shadow slice.** Add the `ThreadRelation` store and graph projection; backfill
   `parent_child` from existing lineage. Measures exactly three things: **relation coverage**
   (active or backfilled), **candidate cardinality** (zero / one / multiple), and **direction
   ambiguity**.

   > **This is not "read-only".** Writing a new projection and backfilling it *is* a persistent data
   > change. What is non-enforcing is the **behavior layer**: nothing is intercepted and legacy
   > delivery is unchanged. The **data layer** writes. Therefore the word "read-only" must not be
   > used to lower its risk classification.
   >
   > **Prerequisites before any write (maintainer gap #5) — "non-enforcing" authorizes nothing:**
   >
   > 1. a **dry run** that produces a diff report and writes nothing;
   > 2. a written **schema + backfill + recovery/rollback contract**, agreed before the first write;
   > 3. a **named accepted owner** for the projection.
   >
   > Absent all three, the slice is not ready regardless of how little it enforces.

   > **It must not classify what purpose a historical message "would have been".** Prose carries no
   > typed ground truth, so any such label is speculation — the same mistake as treating the legacy
   > route as ground truth, one level deeper. Purpose data starts from **prospective typed shadow
   > fields on new calls**; history without a typed purpose is recorded as `unknown` and is never
   > inferred from prose or `effectClass`.
2. **Atomic parent-child edge on child creation**; `cross_thread_send` by `relationId` as an opt-in
   path beside today's `cross_post_message`.
3. **Peer propose/accept**, and `reports_to` for feature → MAIN.
4. **Restrict legacy `cross_post_message`** — last, and only on the coverage numbers step 1
   produces. Read-only discovery and query stay legal throughout; what gets restricted is
   *effectful delivery without a relation*.

Each step ships and reverts independently. **No step is claimed to be near-free.**

> **The legacy route is not ground truth.** `derived !== actual` is a **disagreement**, never an
> error — `actual` is exactly the guess this investigation found unreliable. Correctness may only
> come from operator or typed-incident labels; `null` counts toward coverage, not mismatch.

## 11. Design principles

Inherits the five in `a2a-protocol.md`, and adds one:

6. **Cross a boundary for a purpose, not to reach a place.** A cross-thread act names the
   dependency it serves. Where it lands is derived from the relation that dependency created.

## 11b. Upstream status — **direction rejected**

Filed as [`zts212653/clowder-ai#1490`](https://github.com/zts212653/clowder-ai/issues/1490);
triaged `enhancement` + `needs-maintainer-decision`, **open**.

**Accepted:** the problem, and the core safety direction — discovery is not delivery authority;
server-owned return paths where provenance is already known; generic messaging must not confer
custody; enforcement must be phased and evidence-gated; historical prose must not be reclassified.

**Not accepted as-is:** the protocol surface. Maintainers are treating this as a **candidate new
feature** spanning thread creation/relations, cross-thread transport, custody admission and Approval
Hub semantics — **not** as authorization to extend F193 or to begin implementation.

**That triage was then superseded.** The correction rejects the authorization model outright (see
the banner at the top). The target-side handler and Needs-Me refinements we added in response did
**not** resolve the central problem — they made the authorization lifecycle *more complete*, and the
lifecycle itself was the problem.

The previously-owed item #4 (MCP admission evidence) and the persistent shadow slice are therefore
**no longer requested and will not be produced** under this design.

**Preserved maintainer boundary:**

1. Ordinary message delivery is not custody transfer and does not require structured relationship authority.
2. Evidence and authority are consumed when admitting real custody or executing consequential / irreversible actions — **not as permission to communicate, coordinate, ask for help, or report findings**.
3. Automation failure must degrade automation; it must not freeze communication.
4. `fyi` / `coordinate` / `investigate` remain non-obligation delivery; a real `assign_work` keeps its own explicit authorization and admission path.
5. Misdelivery is addressed through discovery UX, explicit addressing, **receiver-side** constraints, diagnostics and warnings — **not a send-admission allowlist**.

> **No implementation is authorized.** `mindfn/clowder-ai#181` remains a separate draft provenance
> fix and is explicitly **not** the implementation anchor for this protocol.

## 12. Withdrawn — kept as provenance

| Claim | Why withdrawn |
|---|---|
| Five objects (v1) | Server-side workflow; wrong coordinate system for a client-side agent app |
| "Review does not cross threads" as a top-level rule (v2) | Reasoning from action names; independence of context is the criterion |
| `allowedIntents` on the relation instance (v2) | Second source of truth; derivable from `type` |
| `targetCats` on send (v2) | Lets the source name the acting cat — the remote manipulation Q4 forbids |
| `handoff` purpose on the generic send (v3 draft 1) | Would smuggle remote custody transfer back into a message parameter; creation belongs to `propose_thread` |
| `leftThreadId` / `rightThreadId` (v3 draft 1) | Cannot express direction — the server could not tell who may send a `result` or where an `escalation` goes |
| Inferring historical message purpose during migration (v3 draft 1) | No typed ground truth in prose; it is speculation wearing a metric's clothes |
| "child + relation + **initial task**" atomic commit (v3.1) | The F128 approval path persists a child and a seed and creates no `Task` (`proposal-routes.ts:82-84`) — requiring one smuggles a server workflow object in |
| "read-only first slice" (v3.2) | Writing a projection and backfilling **is** a persistent data change; only the *behavior* layer is non-enforcing. Renamed "non-enforcing shadow slice" so the wording cannot lower its risk classification |
| "the source never names the acting cat" as a blanket invariant (v3.2) | Too broad — creation-time `preferredCats` on an operator-approved new child (`proposal.ts:52`) is staffing, not cross-thread recipient addressing. Scoped to delivery into an already-existing context |
| "Primitives are mostly built, just not wired" | A lease is an execution edge, not a relationship graph |
| Anchor PR subjects to `PrTrackingStore` | Notification subscription, overwritten on re-registration; subscription ownership ≠ execution ownership |
| "The system held the answer" (I-1) | **False.** A `subjectRef` says *what is discussed*, not *who to deliver to*; no owner thread existed |
| "Participation is dense by construction" | Unevidenced; 148/960 (15.4%) of historical cross-posts carry any coordination metadata |
| "Misdelivery becomes structurally impossible" | Narrowed once, then **rejected entirely**: an inexpressible mistake makes the *needed* message inexpressible too |
| **Relation-as-gate — the whole authorization model** (v1–v3.3) | Rejected upstream. A second authorization lifecycle sitting between a cat and reporting a blocker freezes communication when it is absent, expired, disputed or unrecoverable. Precedent: `cat-cafe#4255` deleted ~8,088 lines of exactly this shape |

## 13. Open for review

1. ~~Are `peer` and `depends_on` one purpose or two?~~ **Resolved: one.** The difference is
   *relation topology* (who depends on whom — useful for impact analysis, defaults and UI), not a
   difference in the boundary act. `dependency_update` means the same thing on both: one context
   syncing a fact that affects another's work. Whether the receiver adjusts or negotiates is **its**
   judgement. Splitting into `upstream_change` / `peer_negotiation` would put business workflow back
   into the server.
2. Should `peer` relations expire, or stay `active` until explicitly closed?
3. Is `reports_to` a distinct type, or `peer` with a restricted purpose set?
4. Relation to F128 `propose_thread` — is a relation proposal the same approval object?
5. What happens to relations when a thread is archived or deleted?
6. ~~Does `escalation` need a different delivery guarantee?~~ **Resolved:** it needs a different
   **attention** guarantee, not a different **transport** guarantee. All purposes persist
   atomically, are idempotent, and return a real delivery receipt. `escalation` additionally stays
   **`pending_ack`** until the target side explicitly acknowledges or it surfaces in the operator's
   Needs-Me — "written but nobody picked it up" must not report completion. Whether `result`
   requires acknowledgement follows the parent-child `reportingMode`; only `blocking-ack` waits.
