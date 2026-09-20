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

# Cross-Thread Protocol — RFC (DRAFT, not implemented)

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
> `cat_cafe_propose_thread`: on operator approval it atomically creates the child, the
> `parent_child` relation, the initial task and the child-local wake. There is **no `handoff`
> purpose on the generic send tool** — see §8.
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
thread_relation_propose({ candidateThreadId, type, reason })
thread_relation_accept({ relationId })

cat_cafe_cross_thread_send({
  relationId,                 // never a threadId
  purpose: "dependency_update" | "result" | "status_report" | "escalation",
  content,
  replyTo?,
  clientMessageId,
})
```

> **No `targetCats`.** v2 kept it; removed here. The relation authorizes a *context*, and the
> receiving thread routes internally. Letting the source name the acting cat is precisely the
> remote manipulation question 4 rules out. The relation **is** the routing credential.
>
> **No `handoff`.** v3 first draft kept it, which would have smuggled remote custody transfer back
> into a message parameter. This is the mechanical answer to question 4:
>
> > **Only `propose_thread` can create a new work context. `cross_thread_send` can never create or
> > transfer custody on the target side.**
>
> Prose can still *sound* like an order and no server can fully detect that — but a structured
> workflow can no longer hide inside the parameters.

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
| `cat_cafe_propose_thread` | Already carries `parentThreadId` and resolves it at approve time (`proposal-routes.ts:20`, `proposal-approve-overrides.ts:54`). Change: emit a **`relationId`**, and make child + relation + initial task one atomic commit. |
| **`proposal-enrich-header.ts`** | **The sharpest single fix.** At the exact moment a `parent_child` edge is born, it injects a raw call template into the child's header: `` `cat_cafe_cross_post_message(threadId: "…", targetCats: […])` `` (`:57-58`). The relation is *known for certain* here, and we hand the child a string to copy instead. Replace with the `relationId`. |
| `cat_cafe_cross_post_message` | Mark **legacy**. Today one tool carries `threadId` + `targetCats` + `action` + `proposedAction` + `localReviewVerdict` + `coordination` + `effectClass`. That bundle is the defect in tool form. Unbundle, then restrict. |
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

1. **`ThreadRelation` + graph projection**, written but **not enforced**. Backfill `parent_child`
   from existing lineage. Read-only, measuring exactly three things: **relation coverage**
   (active or backfilled), **candidate cardinality** (zero / one / multiple), and **direction
   ambiguity**.

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
| "Primitives are mostly built, just not wired" | A lease is an execution edge, not a relationship graph |
| Anchor PR subjects to `PrTrackingStore` | Notification subscription, overwritten on re-registration; subscription ownership ≠ execution ownership |
| "The system held the answer" (I-1) | **False.** A `subjectRef` says *what is discussed*, not *who to deliver to*; no owner thread existed |
| "Participation is dense by construction" | Unevidenced; 148/960 (15.4%) of historical cross-posts carry any coordination metadata |
| "Misdelivery becomes structurally impossible" | Narrowed: out-of-relation delivery becomes inexpressible; wrongly *accepting* a relation is a separate problem |

## 13. Open for review

1. Are `parent_child` and `subtask_of` one type or two? Likewise `peer` / `depends_on`.
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
