# F167: producer-declared return provenance

Scope: one fork implementation slice, not completion of A2A Lifecycle 1398.
Accepted source: `thread_msr51149hym0i79f#0001791077478338-000059-63edd11d`.
Base: `9a4dd545f727513319bf8fa438f321ae04b79968`.

Architecture cell: dispatch / ball-custody; artifact review retains domain authority.
Map delta: none.
Why: carry one declared category through existing admission, validation and recovery; no new owner or store.
tips_exempt: Backend provenance correction, with no new user-invocable command, tool or guide surface.

## Contract

- `ArtifactReviewReturnStore` commits human feedback, decisions, reopen and image-edit return intents.
  Its existing `ArtifactReviewReturnDispatcher` declares `producer_return` for all four intent kinds.
- `PersistedQueueDelivery` transports that declaration into the canonical Queue row. Public and
  private inputs use the same category type; an existing live row cannot be replayed with a changed
  category. A collision does not progress the original work.
- Ledger validation accepts the new literal. Existing immutable comparison, fingerprint, Redis
  codec, `hydrateFromLedger`, cache and projection preserve it without parsing message text.
- Wake resolution keeps exact event-wait and action fences ahead of ordinary classification.
  `a2a` retains its dispatch resolution. Ordinary `producer_return` uses the existing
  `unstructured/queue_delivery` lifecycle, without creating a wait, action or dispatch carrier.
- Divergent/overlapping wait carriers remain fail-closed. Missing category remains legacy; arbitrary
  category strings remain invalid. CI/review/conflict/issue/continuation and `a2a_failure` policy is unchanged.
- Old pending unclassified rows are not migrated or silently upgraded by retries. Finished public
  messages keep their existing History-owned terminal path; no duplicate category tombstone is added.

## Producer audit boundaries

| Actual producer/path | Disposition |
| --- | --- |
| Artifact review's four committed return kinds | Declare `producer_return` at their common dispatcher |
| GitHubWaitLifecycleService / ReviewFeedbackRouter / ConflictAutoExecutor | Keep typed wait ownership and existing classification |
| ActionSuccessorRecoverySweep composition in index | Keep existing action generation fence and `a2a` transport |
| Managed-command wake composition in index | Keep declared scheduled category and exact hold/action provenance |
| Scheduler public/private/notice delivery wrappers | Keep their declared scheduled category; do not recategorize all wrappers |
| ConnectorRouter / IssueCommentRouter | External input or issue domain classification, not artifact-owner returns |
| Session handoff / QueueProcessor auto-resume | Keep explicit continuation classification |
| ThreadMeetingArtifactDispatcher | User-origin intake or explicitly scheduled presentation retry |
| Collective ingress / Work admission and resume | Domain-owned ingress/admitted work, not classified from its prose; ask owner before extending this slice |
| Podcast generator / game orchestrator | Private new execution requests, not a committed review receipt; no indiscriminate category addition |

This is a bounded census of actual Queue and PersistedQueueDelivery callers, not a claim that every
future producer is covered. No upstream-only caller or repair seam is created.

## Verification criteria

1. RED on the real artifact-review return → Dispatch → QueueProcessor wake, then GREEN.
2. HTTP callback request-judgment → authenticated human decision → durable return → QueueProcessor;
   deterministic provider seam is labeled, not presented as human or real-model acceptance.
3. Redis serialization, new Queue hydration, same-ID replay, changed-category conflict, reversible
   claim recovery, and private admission receipt replay after retirement; only isolated test data.
4. Wait/action/dispatch precedence, unknown/undeclared fail-closed behavior, and existing category
   policy regressions; fresh API/dependency build and focused consumers.

Independent review, isolated live acceptance, co-creator confirmation and fork soak remain separate
delivery gates. This implementation neither merges nor restarts the runtime and does not close #212,
G3/F3, or the overall upstream A2A delivery.
