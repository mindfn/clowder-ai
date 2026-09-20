---
title: "Maintainer issue draft — cross-thread boundary protocol"
doc_kind: note
feature_ids: []
related_features: [F052, F128, F167, F193]
topics: [cross-thread, thread-relation, addressing, maintainer-issue, draft]
created: 2026-09-20
updated: 2026-09-20
status: draft
author: "opus"
description: "送往上游 maintainer 的跨 thread 边界协议 issue 草稿：已核实现状、期望不变量、MCP 影响提案三层结构。"
description_source: human
description_author: opus
description_updated_at: 2026-09-20T05:40:00Z
---

# Maintainer issue — DRAFT (rewritten from RFC v3.1)

> Target: `zts212653/clowder-ai` · Status: **draft, pending final review** · Author: opus · Review: sol
> Proposed title:
> `design: cross-thread delivery has no boundary protocol — asking to confirm direction`

---

## What we are asking

**Direction confirmation, not a merge.** There is no PR behind this and we are not asking you to
approve an implementation. We would rather find out now if you disagree.

The question: **should a cross-thread delivery be authorized by a declared relationship between two
work contexts, instead of by a thread id the caller supplies?**

## 1. Verified current behavior

All read from source.

| Fact | Where |
|---|---|
| Cross-thread target validation is **existence + principal scope only** — no source→target semantic check | `callback-scope-helpers.ts:92-122` |
| One tool carries `threadId` + `targetCats` + `action` + `proposedAction` + `localReviewVerdict` + `coordination` + `effectClass` | `cat_cafe_cross_post_message` schema |
| At the moment a parent/child edge is created, we **inject a raw call template into the child's header** — `` cat_cafe_cross_post_message(threadId: "…", targetCats: […]) `` | `proposal-enrich-header.ts:57-58` |
| Thread lineage exists (`parentThreadId`, `sourceThreadId`, `getChildThreads()`) but **no delivery path reads it**; present on **29/531 threads (5.5%)** | `ThreadStore.ts:238-240`, `:834` |
| `ActionSuccessorLease` records one holder + one predecessor — an **execution edge**, not a relationship graph | `action-successor-state-machine.ts:90-99` |
| Discovery results (`list_threads`, `feat_index`) are routinely treated as routing credentials | tool descriptions |

**Not every structured path is broken** — we want to be precise, because our own early drafts were
not:

| Path | Constraint today |
|---|---|
| Ordinary cross-post | existence + principal scope only |
| task/implement first handoff | **already validated** against `task.threadId` (`ActionSubjectTruthResolver.ts:292`) |
| PR/review first handoff | freshness returns no thread → the check silently no-ops |
| local review terminal return | **already forced** back to the predecessor thread |

### The defect, stated precisely

> For **ordinary cross-post** and **PR-review initial handoff**: when the system cannot resolve an
> independently authorized endpoint, the API still accepts any scope-valid `threadId` and produces
> messages, wakes and custody side effects — and the caller has **no legitimate unknown-target /
> proposal-only exit.**

The load-bearing part is **"no authoritative endpoint, yet effectful delivery is permitted"** — not
"the target thread did not exist".

### Evidence

Six operator-confirmed misdeliveries across eleven threads, 2026-04-30 → 2026-09-19 — five distinct
failure shapes, months apart, different cats and models.

**We falsified our own first hypothesis.** We had assumed the server was binding continuations to
the wrong thread — a claim that had been sitting in one of our skills as a "known open bug". A
full-corpus scan returns three zeros: undeclared cross-thread continuations **0**, wake bound to the
wrong thread **0**, `continuityCapsule`/session drift **0**. These are live-corpus counters that
grow between runs, so we do not quote the totals as fixed figures — the **zeros** are the
load-bearing part and have held on every re-run.

The server delivered exactly where it was asked to. **The asking is what has no design.**

Reproducible: of cross-posts up to a pinned cutoff (`0001789825570936-001932-e5185384`),
**148 / 960 (15.4%)** carry any coordination metadata.

## 2. Desired invariants

These are what we would like confirmed — they matter more than any object model.

1. **Discovery ≠ authorization.** A thread id returned by search is candidate evidence, never a
   delivery credential.
2. **The source does not name the acting cat.** The relation authorizes a *context*; the receiving
   thread routes internally.
3. **Child creation establishes the relation atomically** — the one place the edge is known for
   certain must not hand out a string to copy.
4. **Effectful delivery only along an active relation.** Read-only discovery and query stay legal
   throughout; what gets restricted is delivering without one.
5. **A cross-thread message never transfers custody on the far side.** Creating a new work context
   goes through `propose_thread`; an already-independent thread decomposes itself.

Framing we arrived at, if it is useful: this is **not** a message-routing protocol and **not** a
server-side workflow — it is the **boundary protocol between independent agent work contexts**.
Crossing exists so two contexts that remain independent can exchange what a real dependency
requires, without mixing their goals, memory or execution state.

## 3. Proposed MCP impact — *proposed for confirmation*

Summary only; the full parameter surface is in the RFC.

| | Tools |
|---|---|
| **Retain** | `post_message`, `multi_mention`, A2A disposition — all intra-thread, untouched |
| **Modify** | `propose_thread` (emit a relation id; stop emitting raw address templates), `list_threads` / `feat_index` (say plainly that a returned id is not a routing credential), `get_thread_metadata` (read-only relation projection), `set_thread_metadata` (must not edit relations) |
| **Add** | `propose_thread_relation`, `respond_thread_relation`, `cross_thread_send` (relation + typed purpose + content; no thread id, no target cats, no custody fields) |
| **Deprecate** | `cross_post_message` — unbundled in stages, never removing a capability before its replacement exists |

We are **not** proposing a big-bang rewrite. The first slice is read-only: write the relation graph,
backfill from existing lineage, enforce nothing, and measure relation coverage, candidate
cardinality and direction ambiguity. Restricting the legacy path is last and gated on those numbers.

One thing we will not do: infer from historical prose what purpose a past message "would have had".
There is no typed ground truth there, and a derived-vs-actual disagreement is **not** evidence of a
routing error — the actual route is precisely the guess this investigation found unreliable.

## 4. Links

- RFC (draft, our fork): `docs/architecture/cross-thread-protocol.md` on
  `mindfn/clowder-ai:fix/crosspost-source-thread-tag`
- Investigation, incident corpus, reproducible scanner:
  `docs/bug-report/ghost-thread-cross-thread-session-routing/`
- `mindfn/clowder-ai#181` — deliberately kept **Draft**. It contains a real but *separate* fix (a
  provenance-label single-source extraction). We are explicitly **not** presenting it as a
  misdelivery fix.

## Note on provenance

This RFC went through four revisions and retracted thirteen claims — including its most quotable
line, which turned out to be false, and two object models that were the wrong shape entirely. Every
factual claim above was independently re-derived from source by a second reviewer, and every number
has a pinned, re-runnable boundary. We would rather hand you a smaller claim that holds.
