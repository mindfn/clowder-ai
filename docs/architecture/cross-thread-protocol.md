---
title: "Cross-Thread Protocol — RFC (DRAFT)"
doc_kind: architecture
feature_ids: []
related_features: [F052, F128, F167, F193, F246, F306]
topics: [cross-thread, thread-relation, routing, addressing, rfc]
created: 2026-09-20
updated: 2026-09-20
status: draft
author: "opus"
description: "跨 thread 协作的寻址模型 RFC（精简版）：只新增 ThreadRelation 一个对象，关系边同时是投递授权；服务端只做机械约束，语义判断留给 Agent。"
description_source: human
description_author: opus
description_updated_at: 2026-09-20T03:15:00Z
---

# Cross-Thread Protocol — RFC (DRAFT, not implemented)

> **Status: DRAFT for review.** Nothing here is built.
> Companion: [`a2a-protocol.md`](./a2a-protocol.md) — the message lifecycle *inside* one thread.
>
> **v2 — coordinate system corrected.** v1 of this RFC proposed five persistent objects
> (`Coordination` + `Participation` + `Invitation` + `Delivery` + `Lease`) and four commands. The
> operator's objection was that this is a **server-side workflow orchestrator**, not the design of a
> **client-side agent application** — and that it was simply too complex for the problem. Both are
> correct. v1 used complexity to compensate for the wrong coordinate system: it tried to make the
> *server* understand the collaboration. In a client-side agent app the **agent** understands the
> collaboration; the server only has to stop it escaping a confirmed relationship.
>
> The operator had also already stated the answer several rounds earlier — *"if thread A and B have
> a delivery relationship, the association graph belongs in metadata; each thread's metadata should
> maintain what it is doing."* v2 is that sentence. v1 was me building past it.

## The gap this fills

The A2A protocol defines a message's lifecycle to five design principles, then stops at the thread
boundary:

> **Thread independence.** Each thread has its own event-driven drain and its own queue head. Work
> in one thread never crosses into another's scheduling; anything shared between threads is **an
> explicit, recorded cross-post**. — `a2a-protocol.md`

That sentence is the entire specification of the cross-thread hop. This RFC designs it.

Motivating evidence: six operator-confirmed misdeliveries across eleven threads,
2026-04-30 → 2026-09-19 — see `docs/bug-report/ghost-thread-cross-thread-session-routing/`.

## What exists today — Verified

| Path | Constraint today |
|---|---|
| Ordinary cross-post | existence + principal scope only (`callback-scope-helpers.ts:92-122`) |
| task/implement first handoff | **already validated** against `task.threadId` (`ActionSubjectTruthResolver.ts:292`) |
| PR/review first handoff | freshness returns no thread → the `target_thread` check silently no-ops |
| local review terminal return | **already forced** back to the predecessor thread |

Relevant primitives that already exist: `Thread.parentThreadId` / `sourceThreadId` /
`createdFromProposalId` (`ThreadStore.ts:238-240`), `getChildThreads()` (`:834`), and
`Thread.goal` (F306, `:206`). Lineage is recorded on **29/531 threads (5.5%)** and no delivery path
reads any of it.

`ActionSuccessorLease` holds `holderCatIds/holderThreadId` + `predecessorCatId/predecessorThreadId`
(`action-successor-state-machine.ts:90-99`) — **one execution edge**, not a relationship graph.

## The defect, stated precisely

> For **ordinary cross-post** and **PR-review initial handoff**: when the system cannot resolve an
> independently authorized endpoint, the API still accepts any scope-valid `threadId` and produces
> messages, wakes and custody side effects — and the caller has **no legitimate unknown-target /
> proposal-only exit**.

The load-bearing part is **"no authoritative endpoint, yet effectful delivery is permitted"** — not
"the target thread did not exist". Replying in the source thread, or doing nothing, may well have
been correct handling in several of the incidents.

## The design

> **The server maintains the thread relationship graph and guarantees messages cannot escape a
> confirmed relation. The agent decides whether to collaborate, with whom, and what to say.**
>
> Rails and guardrails from the server. Driving from the cats.

### One new object

`Thread` already carries `goal`, its metadata, and its active cats. Exactly **one** object is added:

```ts
ThreadRelation {
  id
  leftThreadId
  rightThreadId
  type: "parent_child" | "peer" | "reports_to"
  status: "proposed" | "active" | "closed"
  reason
  provenance
  allowedIntents
}
```

It is simultaneously **an edge in the relationship graph** and **the authorization to deliver**.

**Explicitly not created:** `Coordination`, `Participation`, `Invitation`, `Delivery`. An
"invitation" is just a `proposed` relation; accepting makes it `active`. What v1 called a
coordination is the *process* that relations and messages form dynamically — it does not need to be
materialized as a server-side aggregate root. The existing lease keeps meaning only **who holds the
ball**, and is never used to express a thread relationship.

### Sending

```ts
cross_thread_send({
  relationId,                                        // not a threadId
  intent: "delegate" | "result" | "notify" | "coordinate" | "report",
  content,
  targetCats?,
})
```

The server derives the far end from the relation. **There is no field in which to express a wrong
target** — which is a stronger guarantee than v1's, and needs one object instead of five.

## Three flows

### 1. Review — normally does not cross threads at all

A feature is developed in thread A:

```text
thread A
  ├─ developer cat
  └─ reviewer cat
```

Review wakes the reviewer **in thread A**. It is a role switch inside one work context — there is
no reason to go looking for "which other thread is the reviewer in right now".

If review genuinely needs an isolated environment:

```text
thread A
  └─ review child thread R      (parent_child edge written atomically at creation)
```

and the result returns along that edge. No query, no guess, no candidate selection.

> **Most "cross-thread review" should disappear from the product vocabulary.** It was never a
> scheduling category; it was an artifact of having no other way to express the handoff.

### 2. Parent/child — the edge is written at birth

```text
A creates B  →  parent_child(A, B) written in the same transaction
             →  A may delegate to B
             →  B may report/result back to A
```

The caller never types a target thread. Misdelivery in this shape becomes impossible by
construction — which is what the operator meant by *"A creating B obviously cannot misdeliver."*

### 3. Peer collaboration — relate first, deliver second

A finds its change affects B and C:

```ts
thread_relation_propose({ candidateThreadId, type: "peer", reason })
thread_relation_accept({ relationId })
cross_thread_send({ relationId, intent: "coordinate", content })
```

Candidate selection still happens **once**, here. But a wrong guess now creates only an
**auditable, rejectable relation proposal** — it does not inject content, context and a work ball
into a stranger's thread. That is the whole difference.

After B receives coordination info, **B decides what to do inside B's own thread.** A must not
manipulate B's custody through a cross-thread message.

### `reports_to` — MAIN stops being a public inbox

```text
feature thread ──reports_to──► project/main thread
```

`allowedIntents` on this relation type permits only **terminal report**, **milestone report**, and
**blocking escalation**. Not review, not implement, not ordinary chatter. This directly addresses
incident I-4, where several execution threads treated MAIN as a default place to dump updates.

## What the server enforces — mechanically, with no business knowledge

- Source thread is derived from the invocation; it cannot be forged.
- A cross-thread send **must** reference an `active` relation.
- The target is derived from the relation; a bare `threadId` is not accepted.
- `type` constrains which `intent` values are legal.
- Replies travel back along the originating relation.
- The `parent_child` edge is committed atomically with child creation.
- A relation *proposal* carries no work ball and no content side effects.
- agent-key callers cannot bypass a relation to supply a thread directly.
- Thread metadata exposes `goal` and the relation graph.

## What stays with the agent

Whether to notify B and C · whether this is peer / parent-child / reports-to · what the content is ·
whether to close a relation · what the receiving cat should do locally.

These are judgements. Freezing them into server-side workflow was v1's mistake.

## Migration

1. **`ThreadRelation` + graph projection**, written but not enforced. Backfill `parent_child` from
   existing lineage. Read-only: measure how much real traffic *would* have had an active relation.
2. **Atomic parent-child edge on child creation**, and `cross_thread_send` by `relationId` as an
   opt-in path alongside today's `cross_post_message`.
3. **Peer propose/accept**, plus `reports_to` for feature→MAIN.
4. **Restrict legacy `cross_post_message`** — last, and only on the coverage numbers step 1
   produces. Read-only discovery and query stay legal throughout; what gets restricted is
   *effectful delivery without a relation*.

Each step ships and reverts independently. **No step is claimed to be near-free.**

> **The legacy route is not ground truth.** When comparing a derived target against what actually
> happened, `derived !== actual` is a **disagreement**, never an error — `actual` is exactly the
> guess this investigation found unreliable. Correctness may only be computed from operator or
> typed-incident labels; `null` counts toward coverage, not mismatch.

## Design principles

Inherits the five in `a2a-protocol.md`, and adds one:

6. **Address the relationship, not the place.** A cross-thread act names the relation it belongs to.
   Where it lands is derived. The caller is never asked for a coordinate the system already holds,
   and never allowed to invent one it does not.

## Withdrawn from v1 — kept as provenance

| v1 claim | Why withdrawn |
|---|---|
| Five objects (`Coordination`/`Participation`/`Invitation`/`Delivery` + lease) | Server-side workflow orchestration; wrong coordinate system for a client-side agent app |
| "Primitives are mostly built, just not wired" | A lease is an execution edge, not a participation graph |
| Anchor PR subjects to `PrTrackingStore` | It is a notification subscription, overwritten on re-registration — subscription ownership is not execution ownership |
| "The system held the answer" (I-1) | False. A `subjectRef` says *what is discussed*, not *who to deliver to*; no owner thread existed |
| "Participation is dense by construction" | Unevidenced; 148/960 (15.4%) of historical cross-posts carry any coordination metadata |
| "Misdelivery becomes structurally impossible" | Narrowed: out-of-relation delivery becomes inexpressible; wrongly *accepting* a relation is a separate problem |

## Open for review

1. Does `allowedIntents` belong on the relation instance, or is it derivable from `type` alone?
2. Should `peer` relations expire, or stay `active` until explicitly closed?
3. Is `reports_to` a distinct type, or a `peer` relation with a restricted intent set?
4. Relation to F128 `propose_thread` — is a relation proposal the same approval object?
5. What happens to relations when a thread is archived or deleted?
