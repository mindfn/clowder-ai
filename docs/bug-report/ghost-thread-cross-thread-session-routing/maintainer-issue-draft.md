---
title: "Maintainer issue draft — cross-thread addressing"
doc_kind: note
feature_ids: []
related_features: [F052, F128, F167, F193]
topics: [cross-thread, coordination, addressing, maintainer-issue, draft]
created: 2026-09-20
updated: 2026-09-20
status: draft
author: "opus"
description: "送往上游 maintainer 的跨 thread 寻址设计 issue 草稿：精确缺陷陈述、可复现证据、方向提议与明确不提议的范围。"
description_source: human
description_author: opus
description_updated_at: 2026-09-20T02:55:00Z
---

# Maintainer issue — DRAFT for review

> ⛔ **PAUSED — DO NOT FILE.** The operator challenged the object model as over-complex and as a
> *server-side workflow* design rather than a *client-side agent application* design. That objection
> was accepted; the RFC has been rewritten (v2: one `ThreadRelation` object instead of five).
> **This draft still argues the v1 model and is therefore stale.** It must be re-derived from the
> v2 RFC before anything is filed.
>
> What survives unchanged: the precise defect claim, the incident corpus, the falsification of the
> server-side hypothesis, and the pinned 148/960 figure. What does not: the proposed direction and
> the "what we are not proposing" section.
>
> Target: `zts212653/clowder-ai` · Status: **paused, not filed** · Author: opus · Final review: sol
> Proposed title:
> `design: cross-thread delivery accepts any scope-valid threadId when no authorized endpoint exists`

---

## What we are asking

Direction confirmation on an **addressing-model** change before we build anything. We are not
asking for a merge, and we have no PR to offer for it. If you disagree with the direction, we would
rather find out now than after an implementation.

Concretely: **should a cross-thread delivery be addressed to a coordination object rather than to a
thread id supplied by the caller?**

## The defect

For **ordinary cross-post** and **PR-review initial handoff**: when the system cannot resolve an
independently authorized endpoint, the API still accepts any scope-valid `threadId` and produces
messages, wakes and custody side effects — and the caller has **no legitimate unknown-target or
proposal-only exit**.

The load-bearing part is **"no authoritative endpoint, yet effectful delivery is permitted."**
It is *not* "the target thread did not exist" — replying in the source thread, or doing nothing,
may well have been correct handling in some of these cases.

`resolveScopedThreadId()` validates exactly two things: the thread exists, and it is in the caller's
principal scope (`packages/api/src/routes/callback-scope-helpers.ts:92-122`). There is no
source→target semantic check.

### Not every structured path is affected

We want to be precise, because our own first draft was too broad here:

| Path | Constraint today |
|---|---|
| Ordinary cross-post | existence + principal scope only |
| task / implement first handoff | **already validated** against `task.threadId` (`ActionSubjectTruthResolver.ts:292`) |
| PR / review first handoff | freshness returns no thread, so the `target_thread` check silently no-ops |
| local review terminal return | **already forced** back to the predecessor thread |

So two paths are already anchored. The gap is the other two.

## Evidence

**Six operator-confirmed misdeliveries across eleven threads, 2026-04-30 → 2026-09-19.** Not a
single operation slip: five distinct failure shapes, five months apart, different cats, different
models.

**We falsified our own first hypothesis.** We assumed the server was binding continuations to the
wrong thread — a claim that had been sitting in one of our skills as a "known open bug." A
full-corpus scan returns three zeros:

- undeclared cross-thread continuations: **0**
- wake bound to the wrong thread: **0**
- `continuityCapsule` / session thread drift: **0**

These are computed over the **live** corpus (~107k messages, ~7.9k causal edges, ~670 A2A-triggered
sessions at time of writing), so the totals grow between runs — we deliberately do not quote them as
fixed figures. The **zeros** are the load-bearing part, and they have held on every re-run.

The server delivered exactly where it was asked to. That is the point — **the asking is what has no
design.**

**Reproducible counts.** Cross-posts carrying any coordination metadata: **148 / 960 (15.4%)** at a
pinned boundary (cutoff message `0001789825570936-001932-e5185384`). A bare live scan is *not*
reproducible — `SCAN` is not a snapshot and consecutive reads drifted — so the forensics script now
takes the boundary as a flag and refuses to present unpinned numbers as citable.

Thread lineage density, for the alternative we rejected: **29/531 threads (5.5%)** declare a
`parentThreadId`; lineage-based fail-closed would reject 63.6–74.6% of real traffic.

## Why this is not a discipline problem

The correct rule already exists in our `cross-thread-sync` skill: *"cannot verify an owner thread →
`propose_thread`; never guess a nearby thread."* It is written down, and it was violated repeatedly
across five months — consistent with the existing F167 Case E1 finding that **writing a rule is not
executing it**.

There is also nothing to check a guess against. `ActionSuccessorLease` records `holderThreadId` and
`predecessorThreadId`, but those are **two execution endpoints, not a participation set**
(`action-successor-state-machine.ts:90-99`) — no membership, no invitation, no exit, no multi-party
relation. **The participation graph does not exist.**

We also considered and rejected using `PrTrackingStore` as the PR-side authority: its contract is to
"route **notifications** to the correct cat/thread," and re-registering the same subject **overwrites
`threadId`**. Wiring it into custody would let the last tracking registration rewrite the review
holder — subscription ownership misfiled as execution ownership.

## Proposed direction

> **Address the work, not the place.** A cross-thread message is addressed to a **coordination**;
> the thread it renders in is **derived** from that coordination's participation set, never typed by
> the caller.

Two supporting invariants we think matter more than the object model itself:

1. **Derive, don't validate.** A thread coordinate must come from an object that owns that fact
   independently of the delivery call. Validating a caller-supplied value against a field the same
   call path seeded is circular — which is exactly what our first proposal did, before review caught
   it.
2. **You may enroll only the thread you are running in.** The server takes it from the invocation,
   never from a parameter. To bring another thread in, you *invite*; the invitee enrolls itself.
   (agent-key callers have no invocation thread, so they get query and proposal only — never a
   caller-supplied fallback.)

## What we are explicitly *not* proposing

- **No big-bang rewrite.** Our proposed first slice is a **shadow plane** for one PR-review flow:
  persist coordination/participation/invitation, change **no delivery**, and only observe.
- **Fail-closed is last, and gated on data we do not have yet.** We initially claimed participation
  would be "dense by construction"; review correctly struck that as unevidenced. It is an external
  contract change requiring coverage measurement and staged rollout.
- **The legacy route is not ground truth.** In the shadow plane, `derived !== actual` is a
  *disagreement*, never an error — `actual` is precisely the guess this investigation found
  unreliable. Correctness can only come from operator or typed-incident labels.

## Links

- RFC (draft, ~470 lines, our fork):
  `docs/architecture/cross-thread-protocol.md` on `mindfn/clowder-ai:fix/crosspost-source-thread-tag`
- Investigation + incident corpus + reproducible scanner:
  `docs/bug-report/ghost-thread-cross-thread-session-routing/`
- `mindfn/clowder-ai#181` — kept **Draft** on purpose. It contains a real but *separate* fix (a
  provenance-label single-source extraction). We are deliberately **not** presenting it as a
  misdelivery fix.

## Note on provenance

Our first three drafts each contained a claim we later had to retract — including our most quotable
line, which turned out to be false. Everything above has been independently re-derived from source
by a second reviewer. Where a number appears, it has a pinned, re-runnable boundary. We would rather
hand you a smaller claim that holds.
