---
title: "Cross-Thread Protocol — RFC (DRAFT)"
doc_kind: architecture
feature_ids: []
related_features: [F052, F128, F167, F193, F246, F306]
topics: [cross-thread, coordination, routing, addressing, custody, thread-relationship, rfc]
created: 2026-09-20
updated: 2026-09-20
status: draft
author: "opus"
description: "跨 thread 协作的寻址模型 RFC：把协作对象（coordination）提为投递地址，thread 降为参与集合推导出的渲染位置；包含现状核实、与 A2A 五条原则的冲突、工具面与分步迁移。"
description_source: human
description_author: opus
description_updated_at: 2026-09-20T02:30:00Z
---

# Cross-Thread Protocol — RFC (DRAFT, not implemented)

> **Status: DRAFT for review.** Nothing here is built. This document proposes the design;
> it does not describe current behavior. Sections marked **Verified today** are read from
> source at the cited lines; everything under **Proposed** is up for debate.
>
> Companion: [`a2a-protocol.md`](./a2a-protocol.md) — the message lifecycle *inside* one thread.

## The gap this fills

The A2A protocol defines a message's lifecycle to five design principles — but it explicitly
stops at the thread boundary:

> **Thread independence.** Each thread has its own event-driven drain and its own queue head.
> Work in one thread never crosses into another's scheduling; anything shared between threads
> is **an explicit, recorded cross-post**. — `a2a-protocol.md`

"An explicit, recorded cross-post" is the entire specification of the cross-thread hop. It was
never designed to those five principles. This RFC designs it.

Motivating evidence: six operator-confirmed misdeliveries across eleven threads,
2026-04-30 → 2026-09-19 — see `docs/bug-report/ghost-thread-cross-thread-session-routing/`.
The server never mis-bound a thread in any of them. That is the point: **the delivery did
exactly what it was asked to do, and the asking is what has no design.**

## What exists today — Verified

**Revised after review (sol, CHANGES REQUESTED).** An earlier draft said the primitives were
"mostly built, just not wired." That was wrong in two ways, both load-bearing:

- `ActionSuccessorLease` holds `holderCatIds/holderThreadId` + `predecessorCatId/predecessorThreadId`
  and nothing else (`action-successor-state-machine.ts:90-99`). That is **one execution edge, not a
  participation graph** — no membership, no invitation, no exit, no multi-party relation.
  **The participation graph does not exist and must be built.**
- "No delivery path reads the subject" is also too broad. The accurate matrix:

| Path | Constraint today |
|---|---|
| Ordinary cross-post | existence + principal scope only |
| task/implement first handoff | **already validated against `task.threadId`** |
| PR/review first handoff | freshness returns no thread → the check silently no-ops |
| local review terminal return | **already forced back to the predecessor thread** |

> **Scope of this matrix: semantic *target authorization* only.** It deliberately omits the other
> constraints already in force on these paths — routing credentials (F193 AC-A4), deleted-thread
> handling, same-thread `replyTo`, agent-key's ban on structured actions, and cloud exact-return.
> Those are real and unchanged; they simply do not answer "should this land in *this* thread".

The defect is concentrated in **ordinary delivery and PR-review initial handoff** — not in every
structured path. What follows lists primitives that exist, which is not the same as being sufficient.

| Primitive | Status | Source |
|---|---|---|
| Subject-keyed **execution edge** `ActionSuccessorLease` (NOT a coordination object) | **exists** | `domains/ball-custody/ActionSuccessorLeaseStore.ts` |
| …its identity key contains **no threadId**: `action:successor:identity:{tenant}:{subjectRef}:{family}:{slot}` | **exists** | `action-successor-keys.ts:14-16` |
| …it records **two execution endpoints** — `holderThreadId` / `predecessorThreadId`. **These are not a participation set.** | **exists** | `action-successor-state-machine.ts:97,99` |
| …contention: generation + CAS, `replace`, `returnToPredecessor` | **exists** | same domain |
| …terminal semantics: `subjectTerminal` + predicate catalog | **exists** | `ActionTerminalPredicateCatalog.ts` |
| Thread lineage: `parentThreadId`, `sourceThreadId`, `createdFromProposalId` | **exists** | `ThreadStore.ts:238-240` |
| Child index: `getChildThreads(parentThreadId)` | **exists** | `ThreadStore.ts:834` |
| Thread purpose: `goal?: ThreadGoalStateV1` (F306) | **exists** | `ThreadStore.ts:206` |
| `cross_post_message` may carry `action.subjectRef` / `coordination.subjectRef` | **exists, optional** | tool schema |
| **Delivery resolves or validates the target from any of the above** | ❌ **absent** | `callback-scope-helpers.ts:92-122` |

`resolveScopedThreadId()` checks exactly two things: the thread exists, and it is in the
caller's principal scope. `threadId` is **required**; `subjectRef` is **optional**; the two
are **never compared**.

## The defect, in one line

**There is no addressable target, and the tool accepts a guess anyway.**

> **Correction (review round 2).** An earlier draft called I-1 a "decisive sample" and claimed
> *"the system held the answer and asked the caller to guess it anyway."* **That was false and is
> withdrawn.** I-1 declared `subjectRef=subject:f167:c1-custody-recall-deviation`, but a subjectRef
> states *what is being discussed*, not *who to deliver to* — and no lease or owner thread existed
> for that subject at all (the bug report's own finding: F167 had no owner thread). The system did
> **not** hold the answer.
>
> What I-1 actually demonstrates is weaker but still damning: **there was no legitimate target in
> existence, and delivery succeeded regardless.** That is a fail-open defect (A2A principle 5), not
> evidence that a usable answer was ignored.

So the accurate framing is **not** "subject is a passenger, thread is the address" — that presumes a
subject→thread truth exists to be ignored. It does not exist. It has to be built.

### Which A2A principles the cross-thread hop violates

| A2A principle | Cross-thread hop today | |
|---|---|---|
| 1. One owner per fact | The coordination owns "who acts next / where"; the caller **re-adjudicates it by hand** and passes a literal `threadId` | ❌ |
| 2. Change on one cutover | Coordination generation and message delivery commit **separately** | ⚠️ |
| 3. Don't infer one fact from another | Caller infers *target thread* from *a threadId it saw recently* | ❌ |
| 4. One terminal per run | Leases do hold this | ✅ |
| 5. Projections rebuildable; **fail closed** | Delivery **fails open**: unknown or unrelated target → delivered anyway, silently | ❌ |

Three of five. The incidents are not six mistakes; they are one missing design surfacing six times.

## Proposed — Three things the system should track

| Object | Persisted | What it is |
|---|---|---|
| **Coordination** | yes | The collaboration **aggregate root**: a bounded subject/workstream with identity, lifecycle and terminal. **Independent of any thread or message.** A lease is *not* generalized into it — a lease is one execution-responsibility edge **under** a coordination, per action family/slot/revision. Two objects, two lifetimes. |
| **Participation** | yes | The set of (thread, cat, role) admitted into a coordination. **This — not lineage — is the delivery authority.** Expanding it is an explicit, audited act. |
| **Cross-post delivery** | yes | A message admitted **into a coordination** and addressed to a **recipient** (participant or role). Its render thread is derived from that recipient's endpoint. **Not broadcast** — reaching everyone is a separate explicit operation. |

## Proposed — The central inversion

> **A cross-thread message is addressed to a coordination, not to a thread.
> The thread is where it renders — derived from the participation set, never typed by the caller.**

Consequences:

- **Out-of-membership delivery becomes inexpressible** for coordination-bearing messages: there is
  no field in which to name a non-participant thread. **This is narrower than "misdelivery becomes
  impossible"** — it does nothing about *wrongly admitting* a participant in the first place, which
  is why admission needs its own authority model (below). The earlier stronger claim is withdrawn.
- **Adding a participant is a first-class act**, not a free-text id. It is visible, attributable,
  and reversible.
- **Peer collaboration is native.** A finds its change affects B and C → A *expands* (or proposes
  expanding) the coordination to include them. No parent-child relation is required — this answers
  the operator's case directly: lineage was never the right authority.
- **Parent/child is the easy case — but lineage still grants nothing by itself.** A child may join
  at birth **only** when it is created from inside an already-authorized coordination and its
  participation is committed **atomically with thread creation**. A bare `parentThreadId` never
  confers participation. (Round-2 correction: an earlier draft let lineage bootstrap membership,
  which contradicted "lineage is discovery only".)
- **"Cross-thread review" stops being a scheduling category.** Review is bound to a *subject*
  (a PR at an exact HEAD), never to a thread. The reviewer is woken **in the coordination**;
  which thread that surfaces in is a rendering decision. Today's "cross-thread review" is a
  category error the addressing model forces us to commit.

### The residual case — and the fail-closed rule

Some contact is genuinely un-addressed: *"I found something that may matter to whoever owns X."*
That is not a coordination yet. It is a **proposal to form one**.

> **Rule: no coordination → no *effectful* delivery; you may only propose.**
> Read-only discovery and query remain legal — you may always *look*.

This replaces today's fail-open default and is the principle-5 repair. The approval path is
reusable for **lifecycle and UI only**, not for addressing (see the `DispatchProposal` caveat below).

**"Dense by construction" is withdrawn — it had no evidence.** There is no persistent participation
set today, so its future density is unmeasured. Of **960** historical cross-posts only **148** carry
any coordination metadata — and metadata is not membership truth anyway.

> **Provenance for 960 / 148 — reproduced twice, independently.** Reviewer measured it via read-only
> `SCAN + HMGET`; the author then re-derived the same figures (960 cross-posts, 148 with coordination
> metadata, 15.4%) from the committed scanner, which now takes the boundary as a flag:
>
> ```
> node forensics/scan-cross-thread-routing.mjs \
>   --through-message-id 0001789825570936-001932-e5185384
> ```
>
> Fixed snapshot boundary:
>
> - cutoff timestamp `1789825570936`, cutoff message `0001789825570936-001932-e5185384`
> - predicate: `timestamp <= cutoff && extra?.crossPost?.sourceThreadId` → 960;
>   of those, `extra.coordination` present → 148
>
> **A bare scan of the live store is not reproducible** — two consecutive reads drifted 965 → 966
> (and 154), and `SCAN` is not a snapshot. Any use of these numbers must pin the cutoff.

Fail-closed is therefore **not** a free consequence of this design. It is an external contract
change that requires, in order: build the participation set → backfill → **quantify real coverage** →
staged rollout. It needs operator and maintainer sign-off, not just this document.

For contrast, the rejected alternative: lineage density is 5.5% (29/531 threads) and lineage-based
fail-closed would reject 63.6–74.6% of real traffic. Participation *should* do better — but
"should" is a hypothesis to be measured, not a property to be assumed.

## Proposed — Recipient semantics (participation is not an audience)

Membership answers *who may take part*. It does **not** answer *who this message is for*.
A, B, C all being in a coordination does not mean every sentence A writes should reach B and C.
Four distinct concepts, deliberately not collapsed:

| Concept | Answers | Owner |
|---|---|---|
| **Participation** | who is eligible to take part | Coordination |
| **Recipient** | who *this* message is addressed to | The message |
| **Render thread** | where it surfaces | **Derived** by the server from the recipient's endpoint |
| **Broadcast** | reach everyone | A separate, explicit operation — never a default |

An earlier draft wrote "rendered in each participant thread," which silently made broadcast the
default. Withdrawn.

## Proposed — Thread relationship management

Two different relations, deliberately not merged:

| Relation | Authority for | Filled by |
|---|---|---|
| **Lineage** (`parentThreadId`, `sourceThreadId`) | **Discovery only** — a hint when *forming* a coordination | Thread creation |
| **Participation** (coordination membership) | **Delivery** — the only thing that authorizes a hop | The act of coordinating |

Lineage must stay advisory. Absence of a lineage edge does **not** mean a delivery is illegitimate:
Core↔Plugins-style cross-feature collaboration legitimately has no lineage edge. Lineage is a clue,
never an allowlist.

`goal` (F306) already records what a thread is *for*. It should feed **coordination formation and
review** (does this thread's purpose match what it is being pulled into?) — advisory, never a gate.

**On the operator's "thread metadata should hold the association graph":** agreed in intent, but it
must not become a second writable table. Coordination + versioned Participation is the single source
of truth; thread metadata exposes only a **rebuildable projection** —
`coordinationId / subjectRef / role / status / provenance`. An independently writable association
table would drift from the authority by construction, which is principle 1 all over again.

## Proposed — Tool surface

The tool shape is where today's model is taught. It currently teaches addressing-by-thread.

**Separate faces, or collaboration semantics keep living on the message.** A single
`coordination_post` that can also carry review/assign_work would reproduce today's defect one layer
up. Four distinct verbs:

```ts
coordination_post({                    // ordinary message, addressed to a recipient
  coordinationId,
  recipient:
    | { kind: "participant"; participantId: string }
    | { kind: "role"; role: string; cardinality: "exactly_one" | "all" },
  content,
  replyToMessageId?,
  clientMessageId,
})                                     // no threadId, no raw targetCats

coordination_broadcast({ ... })        // reaching everyone is explicit, never a default
coordination_transfer({ ... })         // review / implement responsibility movement
coordination_propose({ subject, rationale, candidates? })   // the legal "I don't know" exit
```

`verdict` / `completion` are **lease state transitions**; the carrier message is a projection
generated atomically with the transition — never the authority itself.

| Today | Proposed |
|---|---|
| `cross_post_message(threadId, …)` — `threadId` required, `subjectRef` optional | `coordination_post` above — recipient-addressed, render thread derived |
| No way to say "I don't know the id" | `coordination_propose` — the legal "I don't know" exit |
| Target expansion = type another threadId | invite → accept (below) — explicit, audited, never a direct write of another party's endpoint |
| Misdelivery has no signal | out-of-membership addressing is rejected at the API, not discovered by a human |

> **Caveat on reuse:** the existing approval path is reusable only for its **lifecycle and UI**.
> `DispatchProposal` persists caller-supplied `targetThreadId` in the entity *and its canonical key*
> (`callbacks.ts:2493`), so its **addressing payload cannot be carried over**.

Legacy `cross_post_message` remains for the un-coordinated case but fails closed **for effectful
delivery only** — read-only discovery and query stay legal.

## Proposed — Derivation, not validation (reviewer-driven correction)

**Review objection (sol, 2026-09-20):** *"`ActionSuccessorLease` recording `holderThreadId` does not
mean it owns a pre-trustworthy participation set. If the lease is seeded with a caller-supplied
target thread at creation, then 'validate the address against the lease' is circular."*

**Verdict: confirmed, and bounded.** Traced through the real call chain:

| Where | `holderThreadId` comes from | Circular? |
|---|---|---|
| Lease creation | `holderThreadId: input.targetThreadId` — the caller's target (`ActionSuccessorAdmissionService.ts:255,325`) | **yes, by itself** |
| Standing check | compares `input.targetThreadId !== freshness.holderThreadId` (`:69`) | depends on `freshness` |
| `freshness` for **task** subjects | **`task.threadId`** — an independently persisted object (`ActionSubjectTruthResolver.ts:292`) | ❌ **no — already anchored** |
| `freshness` for **PR** subjects | not produced; `holderThreadId` only flows in as `context.holderThreadId` (`:233`), so the `!== undefined` guard **silently no-ops** | ✅ **yes — caller echo** |
| Local-review terminal route | `holderThreadId: actor.threadId` — server-known from the invocation (`callbacks.ts:2266`) | ❌ **no** |

So the objection is exactly right for `review`/PR subjects, and already solved for `implement`/task
subjects — and the in-tree solution shows the general shape.

### The invariant this forces

> **A thread coordinate must be *derived* from an object that owns that fact independently of the
> delivery call — never *validated* against a value the same call path seeded.**

Validation cannot repair a first write that was never checked. Only derivation can.

Three non-circular anchors, all already present:

| Anchor | Owns the thread fact | Status |
|---|---|---|
| `task.threadId` | task subjects | in use today (`:292`) |
| `PrTrackingStore`: `(repoFullName + prNumber) → { catId, threadId, userId }` | PR subjects | **exists, not wired to custody** |
| `actor.threadId` — the invocation the caller is actually running in | self-enrollment | in use today (`callbacks.ts:2266`) |

### Enrollment rule

The third anchor generalizes into the rule that makes misdelivery inexpressible:

> **You may enroll only the thread you are running in.** The server takes it from the invocation,
> never from a parameter. To bring another thread in, you *invite*; the invitee enrolls itself.

Nobody can ever write another thread's id into a delivery path, because the only thread anyone can
name is their own — and they don't get to name it, the server does. The first participant is
bootstrapped by **operator approval** (`effectClass=assign_work`) or by atomic creation inside an
already-authorized coordination — **not by bare lineage**.

**This rule is necessary but not sufficient.** Invocation-bound self-enrollment prevents *forging
someone else's thread*. It does not prevent a wrong invitation, the wrong parallel invocation
accepting, or a wrong admission. Those need subject/role standing, invitation capability, and —
where responsibility expands — human approval.

### agent-key: fail closed, no fallback

An agent-key caller has **no invocation thread**, so it has no self to enroll. Today the server
already refuses coordination/action metadata from agent-key callers and accepts only a raw
`threadId` under scope validation (`callbacks.ts:1365`).

> **A caller-supplied thread must never be accepted as a self-enrollment fallback.**

Without a server-pre-bound endpoint/capability, an agent-key caller may only **query** or **propose**.

### Invitation protocol

```ts
coordination_invite({ coordinationId, invitee: { catId } | { role },
                      role, authorityRef, subjectRevision, expiresAt, idempotencyKey })
coordination_accept({ invitationId, idempotencyKey })
```

On accept the **server derives** cat / user / thread / invocation and validates tenant, generation,
subject standing, role and uniqueness. Operator/system admission is a separate explicit path with
its own permission and audit trail.

> **Idempotency is not eligibility.** Single idempotent consumption solves the *race*, not the
> *correctness* question: when one `catId` has several equally-qualified live endpoints (parallel
> invocations), arrival order must **not** decide. The server returns **`ambiguous_endpoint`** and
> escalates to explicit selection or operator approval.

An agent-key caller may accept **only** with a server-pre-bound capability; otherwise it is limited
to query and proposal.

## Proposed — Migration

1. ~~**Wire, don't build** — resolve/validate `threadId` against the lease.~~
   **Withdrawn** — circular for PR subjects (see above). Replaced by:

   ~~**1'. Anchor PR subjects to `PrTrackingStore`.**~~ **Also withdrawn** — it is the wrong owner.
   `PrTrackingStore` is a *notification subscription*: its contract is "route **notifications** to the
   correct cat/thread" (`PrTrackingStore.ts:2-5`), registration states `why: "**Notify** this thread
   about external GitHub activity"` (`callbacks.ts:5595`), and re-registering the same subject
   **overwrites `threadId`** (`TaskStore.ts:133`). Wiring it into custody would let the *last tracking
   registration* rewrite the review holder — writing "subscription ownership" into "review execution
   ownership." It may serve as a **discovery signal only, never as holder-thread truth.**

   **There is no cheap subset.** Migration starts at step 2.
2. **Shadow plane — the first independently shippable slice.** For **one** PR-review flow, persist
   Coordination / Participation / Invitation for real: source enrolls only via its own invocation,
   target joins by cat-scoped invite + accept. Record the audit trail and the metadata projection,
   but **do not change delivery** — only compare the *derived* endpoint against the *actual* target.
   Ships alone, reverts alone, and produces the coverage/ambiguity data that step 4 requires before
   it can even be evaluated.
3. **Opt-in `coordination_post`**, then structured `coordination_transfer`.
4. **Fail closed for legacy effectful delivery** — last, and only on the shadow plane's numbers.

Each step is independently shippable and independently reversible. **No step is "near-free"** — the
earlier claim that one was is withdrawn (see the withdrawn steps above).

## Design principles

Inherits all five from `a2a-protocol.md`, and adds one:

6. **Address the work, not the place.** A collaboration act names the subject it belongs to.
   Where it renders is derived. A caller is never asked for a coordinate the system already holds —
   and never allowed to invent one it does not.

## Resolved positions (review round 2)

These five were open questions; the reviewer proposed answers and this draft adopts them. They are
positions to be confirmed by the maintainer, not settled facts.

1. **Granularity.** Coordination persists per bounded **subject/workstream**. The lease keeps
   expressing **one execution responsibility** per action family/slot/revision. Two objects, two
   lifetimes — do not merge them.
2. **Admission authority.** A participant may *propose* admission. Responsibility expansion requires
   invitation-acceptance, owner policy, or operator approval. **No participant may directly write
   another party's endpoint.**
3. **Fail-closed** is an external contract change: requires operator + maintainer sign-off, coverage
   quantification, and staged rollout. Not implied by this design.
4. **F128 `propose_thread`** and "propose a coordination" are **siblings**, not the same object.
5. **Archived/deleted participant thread** → participation becomes `inactive`/tombstoned: history
   retained, no new delivery, no cascade delete; restoring requires explicit reactivation.

## Status and next step

**Not ready for a maintainer issue, and not eligible for ADR promotion.** Consensus holds on the
diagnosis (this is an addressing-model defect, not a cat-attention defect) and on the direction
(coordination should be the address authority). Still unconverged: the **object boundary** between
coordination and lease, **admission authority**, **recipient semantics**, and **migration**.

Order: revise this RFC → one more design re-review → then the maintainer design issue → then
implementation. Draft conclusions must not be written into normative skills before that.
