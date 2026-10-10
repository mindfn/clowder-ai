## Problem

Sending an ordinary chat message performs optional capability discovery before the target can accept execution. We should audit what is automatically fetched/injected on this critical path, retain required identity/routing/session context, and make optional retrieval explicit and bounded.

A confirmed example is Signals article injection. Both serial and parallel routes call `signalArticleLookup(threadId)` before model invocation. `createSignalArticleLookup` first reads all inbox records, then sequentially reads each article's study metadata to discover whether it belongs to the thread. A thread with no linked articles still traverses the library. This is Signals/news/article retrieval, not the normal message history or memory lookup.

Code at the published A2A candidate `028a63af71bc3ae6f9ebf9fcf8bd542c0e02d40b`:

- [serial route](https://github.com/zts212653/clowder-ai/blob/028a63af71bc3ae6f9ebf9fcf8bd542c0e02d40b/packages/api/src/domains/cats/services/agents/routing/route-serial.ts)
- [parallel route](https://github.com/zts212653/clowder-ai/blob/028a63af71bc3ae6f9ebf9fcf8bd542c0e02d40b/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts)
- [Signals lookup](https://github.com/zts212653/clowder-ai/blob/028a63af71bc3ae6f9ebf9fcf8bd542c0e02d40b/packages/api/src/domains/signals/services/signal-thread-lookup.ts)

## Observations and limits

In the fork after [Clowder PR1398](https://github.com/zts212653/clowder-ai/pull/1398)'s candidate was merged, one idle-input admission measured 1,056ms from ingress to execution acceptance: Queue preparation 14.27ms, route preparation 984.82ms, response admission 3.27ms. Within route preparation, memory/feedback took 467.75ms and identity/linked-context 354.85ms. The later 8.9s native Codex client startup is a separate problem, not an explanation for this internal second.

A synthetic, isolated file fixture (no user data, Redis or model service) reproduced the Signals lookup cost for an unrelated thread: 500 articles took 27–28ms; 2,000 took 106–111ms, all with zero matches. This proves unnecessary work grows with the article library; it does **not** attribute the entire live 354.85ms bucket to Signals.

## Audit scope

The following preparation surfaces merit an inventory and cost/necessity check. Only the Signals scan above is confirmed unnecessary here; the other rows are investigation targets, not proven defects.

| Surface | Current preparation work | Audit question |
| --- | --- | --- |
| Signals articles | Global inbox + sequential article metadata discovery; snippets/history added automatically | Use existing `signal_search` / `signal_get_article` on demand instead of scanning on ordinary sends |
| Entity nudges | Alias discovery against evidence data | Is work bounded to the current input and necessary before acceptance? |
| Proactive memory | Owner-scoped message-window scan, privacy checks, candidate registry lookup | Avoid repeatedly hydrating a broad window for each send; preserve owner/privacy boundaries |
| Disposition feedback | Up to 50 lexical candidates, sequential exact-subject resolution and ledger reads | Repeated discovery/query cost versus indexed exact subjects; preserve truth checks |
| Proposal status | Up to 200 recent messages scanned for proposal cards, then live candidate checks | Explicit proposal references/status questions versus unconditional discovery |
| Concierge search | Automatically composed search context where enabled | What user/task evidence makes retrieval needed? |
| Always-on evidence / world / packs | Conditional document, world or pack context | Explicit activation, bounded reads and prompt budget |
| Identity / routing / session / message history | Core execution and continuity context | Keep correctness; measure separately from optional capabilities |

## Proposed outcome

1. Ordinary sends do not search Signals automatically. Article tools, study/link actions and stored content remain available.
2. Classify each preparation fetch as execution-required, explicitly activated, or on-demand; document the trigger and real consumption path.
3. Measure internal admission independently of provider startup, with per-operation timings and large-library/no-match fixtures.
4. Remove unnecessary work at its ownership boundary rather than adding per-source conditions, an unconditional cache, or moving slow work behind an earlier status label.
5. Preserve authorization, privacy, durable lifecycle and session recovery behavior.

A local fork follow-up currently removes the automatic Signals dependency from both routing strategies and has red→green serial/parallel regressions. It is not yet reviewed/merged; no claim that all admission latency is solved. Remaining memory/feedback cost is still under investigation.

Related: [Clowder issue839](https://github.com/zts212653/clowder-ai/issues/839) inventories injection visibility; this issue focuses on **retrieval necessity and latency on ordinary sends**, not another Console editor or runtime injection framework.
