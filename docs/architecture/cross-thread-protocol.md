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

The primitives are mostly already built. They are just not connected to delivery.

| Primitive | Status | Source |
|---|---|---|
| Subject-addressed coordination object `ActionSuccessorLease` | **exists** | `domains/ball-custody/ActionSuccessorLeaseStore.ts` |
| …its identity key contains **no threadId**: `action:successor:identity:{tenant}:{subjectRef}:{family}:{slot}` | **exists** | `action-successor-keys.ts:14-16` |
| …it records participating threads: `holderThreadId` / `predecessorThreadId` | **exists** | `action-successor-state-machine.ts:97,99` |
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

**Subject is a passenger. Thread is the address.**

Decisive sample (I-1): the sender declared the correct
`subjectRef=subject:f167:c1-custody-recall-deviation` and the message still landed in an
unrelated thread — because no code path resolves or validates `threadId` from that subject.
The system held the answer and asked the caller to guess it anyway.

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
| **Coordination** | yes | A subject being worked. Has identity, lifecycle, and a terminal. **Independent of any thread or message.** Generalizes today's `ActionSuccessorLease` beyond `review`/`implement`. |
| **Participation** | yes | The set of (thread, cat, role) admitted into a coordination. **This — not lineage — is the delivery authority.** Expanding it is an explicit, audited act. |
| **Cross-post delivery** | yes | A message admitted **into a coordination**, rendered in each participant thread. Carries causal refs to the coordination and its source. |

## Proposed — The central inversion

> **A cross-thread message is addressed to a coordination, not to a thread.
> The thread is where it renders — derived from the participation set, never typed by the caller.**

Consequences:

- **Misdelivery becomes structurally impossible** for coordination-bearing messages. You cannot
  address a thread that is not a participant; there is no field in which to express the mistake.
- **Adding a participant is a first-class act**, not a free-text id. It is visible, attributable,
  and reversible.
- **Peer collaboration is native.** A finds its change affects B and C → A *expands* (or proposes
  expanding) the coordination to include them. No parent-child relation is required — this answers
  the operator's case directly: lineage was never the right authority.
- **Parent/child is just the easy case.** Child-thread creation registers participation at birth,
  so the A→B hop the operator called "impossible to get wrong" becomes actually impossible.
- **"Cross-thread review" stops being a scheduling category.** Review is bound to a *subject*
  (a PR at an exact HEAD), never to a thread. The reviewer is woken **in the coordination**;
  which thread that surfaces in is a rendering decision. Today's "cross-thread review" is a
  category error the addressing model forces us to commit.

### The residual case — and the fail-closed rule

Some contact is genuinely un-addressed: *"I found something that may matter to whoever owns X."*
That is not a coordination yet. It is a **proposal to form one**.

> **Rule: no coordination → you may not deliver; you may only propose.**

This replaces today's fail-open default and is the principle-5 repair. The proposal path already
exists in shape (`propose_thread` / Approval Hub / `effectClass=assign_work`).

Note this rule is **cheap in a way lineage-based rejection is not**: participation is *created by
the act of coordinating*, so it is dense by construction. Measured lineage density is 5.5%
(29/531 threads), and lineage-based fail-closed would reject 63.6–74.6% of real traffic — which is
why the bug report rejected it. Participation-based fail-closed has no such penalty.

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

## Proposed — Tool surface

The tool shape is where today's model is taught. It currently teaches addressing-by-thread.

| Today | Proposed |
|---|---|
| `cross_post_message(threadId, …)` — `threadId` required, `subjectRef` optional | `coordination_post(coordinationId, …)` — participation resolves rendering; **no caller-supplied thread** |
| No way to say "I don't know the id" | `coordination_propose(subject, rationale, candidates?)` — the legal "I don't know" exit |
| Target expansion = type another threadId | `coordination_admit(coordinationId, participant, evidence)` — explicit, audited |
| Misdelivery has no signal | Wrong-participant admission is rejected at the API, not discovered by a human |

Legacy `cross_post_message` remains for the un-coordinated case but **fails closed** and routes
to the proposal path.

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
name is their own — and they don't get to name it, the server does. Bootstrap for the first
participant comes from lineage (thread creation) or operator approval (`effectClass=assign_work`).

## Proposed — Migration

1. ~~**Wire, don't build** — resolve/validate `threadId` against the lease.~~
   **Withdrawn** — circular for PR subjects (see above). Replaced by:

   **1'. Anchor the subject, then derive.** Give PR subjects the anchor task subjects already have:
   resolve `holderThreadId` from `PrTrackingStore` instead of echoing the caller. The existing
   `target_thread` standing check (`:69`) then stops no-opping and becomes load-bearing **for free** —
   no new comparison logic, just a non-`undefined` value from an independent owner.
   This still covers cross-thread review, the operator's sharpest case. *(Decision Packet C1, revised.)*
2. **Generalize the coordination** beyond the two action families.
3. **Invert the tool surface** — coordination-addressed posting becomes primary.
4. **Fail closed** — un-coordinated cross-post degrades to proposal. *(Last, once 1–3 make the
   legal path always available.)*

Each step is independently shippable and independently reversible. Step 1 is near-free and does
not depend on the rest.

## Design principles

Inherits all five from `a2a-protocol.md`, and adds one:

6. **Address the work, not the place.** A collaboration act names the subject it belongs to.
   Where it renders is derived. A caller is never asked for a coordinate the system already holds —
   and never allowed to invent one it does not.

## Open questions for review

1. **Coordination granularity.** One per subject (PR, feat, task)? Long-lived per feature, or
   per handoff chain? Today's lease is per `(subject, family, slot)` — is that the right grain
   to generalize, or an artifact of custody?
2. **Who may admit a participant?** Any current participant, the originator only, or
   operator-gated for `assign_work`-class expansion?
3. **Does step 4 (fail closed) need operator approval per the bug report's Decision Packet**, or
   is it implied once the proposal path is always available?
4. **Relationship to F128 `propose_thread`** — is "propose a coordination" the same object as
   "propose a thread", or a sibling?
5. **What happens to a coordination when a participant thread is archived or deleted?**
