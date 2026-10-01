---
doc_kind: plan
created: 2026-10-01
feature_ids: [F117]
---

# F117 F3 — exact ordinary-token counting without quadratic rescans

Owner: sol / gpt-6.1-sol. Independent change; G3's approved candidate is not modified.

## Admission

Architecture cell: the synchronous local context-budget estimator.

Map delta: same public functions, o200k_base vocabulary, regex boundaries, ordinary-text special-token handling, and per-field UTF-16 truncation. Replace repeated full BPE scans with a rank-ordered queue that updates only adjacent pairs. No persisted state, worker/runtime configuration, credentials, new dependency, or external API change.

Why: the matched 142-message reconstruction blocked the event loop for 553/328 seconds on candidate/pre-G3 baseline; 97%/96% of CPU samples were in js-tiktoken's synchronous bytePairMerge. Raising timeouts or approximating counts would not preserve the budget contract.

Risk route: high-assurance targeted. Behavior/availability and budget-preservation contract are affected. Independent review must examine exact merge order, adversarial input complexity and consumer budget boundaries; context-blind resource/security review remains required before merging. Human experience/soak are separate release gates.

Canonical source: `packages/api/src/utils/token-counter.ts#estimateTokens`, `#estimateTokensFromMessages`; the dependency's public `js-tiktoken/ranks/o200k_base` export supplies the unchanged regex and vocabulary. Do not access private encoder fields or patch node_modules.

Consumer evidence / code-derived census (rerunnable):

```sh
rg -l "from ['\"][^'\"]*utils/token-counter\\.js['\"]" packages/api/src
```

16 imports: serial/parallel routing, route-helpers, ContextAssembler, SessionBootstrap, buildThreadMemory, invoke-single-cat, provider-presentation-delivery, antigravity-continuity-bootstrap, format-memory-cues, PersonMemoryInformedEvidence, PersonMemoryRecallService, person-memory-proposal-preflight, person-memory-proposal-source-contract, meeting-artifact-read-budget, and trace-collector. Other functions named estimateTokens use different estimators and are not silently migrated. No production consumer currently imports estimateTokensFromMessages.

Claim guard / characterization:

- Ordinary counts match `encodingForModel('gpt-4o').encode(text, [], [])` for multilingual, special-literal, UTF-16 edge and seeded differential inputs. Wrong regex, rank ordering or tie-breaking is RED.
- Compare optimized BPE against an exhaustive reference with explicit equal-rank/overlapping/invalidated-neighbor cases and seeded pieces. Merging stale adjacency or choosing the wrong equal-rank occurrence is RED.
- A 12,000-character contiguous Chinese piece runs in a timeout-bounded owned child and measures timer delay, not just CPU completion. Existing implementation is RED within five seconds, without freezing the parent.
- Message truncation remains per field before encoding; non-text blocks remain ignored. Context-budget/bootstrap/memory/presentation tests cover consumer decisions.
- Reuse the original controlled heavy-context reconstruction only for targeted F3 responsiveness/output comparison; it is not full alpha replay or human acceptance.

Migration/restart/rollback: no data or runtime semantics migration. Feature checkout builds/tests only. Revert the implementation commit to restore the estimator; any future runtime load requires operator-controlled restart. G3 #210 remains Draft pending its independent human gate.

## Algorithm boundary

Both algorithms start with the same UTF-8 bytes and merge the currently smallest-ranked adjacent pair, choosing the leftmost on equal rank. A merge changes only the pair on its left and its own new right pair. The queue retains unaffected candidates and discards stale ones using both stored boundaries. A complete byte vocabulary guarantees each remaining segment is one token. With a vocabulary-bounded maximum token width, lookups are bounded and queue operations are O(n log n), rather than O(n²) rescans/splices. No arbitrary chunking, lossy sampling, approximate fallback, text cache, or special-token interpretation is introduced.
