# PR Conversation Comment Wait Implementation Plan

**Feature:** Issue #1377 — `https://github.com/zts212653/clowder-ai/issues/1377`
**Goal:** Let a PR owner explicitly wait for a post-baseline conversation comment from an exact allowlist of GitHub logins without restoring noisy all-comment wakeups.
**Acceptance Criteria:** The shared/API/MCP contract exposes `pr_conversation_comment_added`; `authorLogins` is required, bounded, unique case-insensitively, and exact-login matched; only post-baseline conversation comments match; comment bodies never enter the wake; unrelated comments and existing predicates keep their current behavior.
**Architecture cell:** `ball-custody`
**Map delta:** none
**Map delta why:** This appends one source predicate to the existing F280 AwaitState catalog; ownership, lifecycle, generation fencing, consumption, and persistence remain unchanged.
**Architecture:** Extend the closed predicate union with `{ kind: 'pr_conversation_comment_added', authorLogins: readonly string[] }`. The review collector already supplies post-cursor comment facts; the router projects body-free conversation-comment metadata into the matcher, which compares each ID with the server-frozen conversation baseline and exact-matches normalized logins. The existing wait lifecycle still performs the one-shot CAS consume and compact delivery.
**Tech Stack:** TypeScript, Zod, Node test runner, pnpm, Biome
**前端验证:** No

---

## Finish Line

One explicit registration can wake exactly once when a named GitHub author adds a normal PR conversation comment after registration, while all non-allowlisted, inline, historical, and replayed comments remain state-only.

Not building: role/association predicates, wildcard authors, comment-body matching, inline comment waits, a second tracker, or a new persisted cursor.

## Terminal Schema

```ts
type GitHubPrWaitPredicate =
  | { readonly kind: 'pr_conversation_comment_added'; readonly authorLogins: readonly string[] }
  | ExistingGitHubPrWaitPredicates;

interface GitHubWaitFacts {
  readonly review?: {
    readonly conversationComments?: readonly {
      readonly id: number;
      readonly author: string;
      readonly sourceRef?: string;
    }[];
    // existing review facts remain unchanged
  };
}
```

`authorLogins` is canonicalized by schema admission: 1–20 trimmed non-empty entries, no case-insensitive duplicates. Matching lowercases both sides but preserves the GitHub author spelling in the compact delta.

## Stateful Object Gate

No new lifecycle object or persisted state is introduced. The only stateful object remains the existing F280 `AwaitState`, owned by `GitHubWaitLifecycleService` and fenced by its containing task/action generation. Registration freezes `baseline.review.conversationCommentCursor`; observation with no matching author leaves the wait active while collector cursors advance; the first matching post-baseline fact consumes the generation; replay, owner-generation change, expiry, cancellation, and terminal PR behavior stay under existing tests and code.

Invariants:

- INV-1: registration history is baseline and never wakes.
- INV-2: a conversation comment matches only when `id > baseline.review.conversationCommentCursor`.
- INV-3: login comparison is exact after case normalization; substring, role, and authorAssociation do not participate.
- INV-4: inline comments and review decisions cannot satisfy this predicate.
- INV-5: one matching observation consumes at most one wait generation even if several allowlisted comments arrive together.
- INV-6: compact deltas may carry author, ID, and GitHub source reference, never body text.

Adversarial checks: duplicate login case variants are rejected; pre-baseline and replayed comments do not match; mixed-author batches match only allowlisted authors; multiple matching comments remain one lifecycle wake.

### Task 1: Add RED contract and matcher coverage

**Files:**

- Modify: `packages/api/test/review-feedback-router.test.js`
- Modify: `packages/api/test/scheduler/review-feedback-spec.test.js`
- Modify: `packages/mcp-server/test/f280-register-pr-wait-contract.test.js`

1. Add a router test that registers `pr_conversation_comment_added` for `Maintainer`, observes comment ID 21 by `maintainer`, and expects one compact notification with a source reference and no body.
2. Add negative cases for another author, inline comments, pre-baseline/replay IDs, and case-insensitive duplicate `authorLogins` admission.
3. Add a scheduler test proving the comment facts reach the router while preserving the body-free boundary.
4. Add an MCP schema/forwarding test for the new predicate.
5. Run the targeted tests after building the current source and confirm they fail because the predicate is rejected or unmatched:

```bash
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api build
node --test packages/api/test/review-feedback-router.test.js packages/api/test/scheduler/review-feedback-spec.test.js
pnpm --dir packages/mcp-server build
node --test packages/mcp-server/test/f280-register-pr-wait-contract.test.js
```

### Task 2: Implement the shared and API predicate

**Files:**

- Modify: `packages/shared/src/types/github-wait.ts`
- Modify: `packages/api/src/domains/github-signals/GitHubWaitPredicateCatalog.ts`
- Modify: `packages/api/src/infrastructure/email/ReviewFeedbackRouter.ts`

1. Append the predicate variant and kind to the shared closed union.
2. Add the strict Zod variant with bounded `authorLogins` and case-insensitive duplicate rejection.
3. Extend review facts with body-free conversation-comment metadata.
4. Match only post-baseline conversation IDs from exact normalized authors and emit a compact delta/source reference.
5. Project conversation comments from `ReviewFeedbackRouter` into facts without their bodies.
6. Rebuild shared/API and rerun the Task 1 API tests to GREEN.

### Task 3: Publish the MCP and operator-facing contract

**Files:**

- Modify: `packages/mcp-server/src/tools/callback-tools.ts`
- Modify: `cat-cafe-skills/refs/pr-signals.md`

1. Add the same strict predicate schema and TypeScript input variant to `register_pr_tracking`.
2. Update the tool description so Use/Not-for/Output boundaries explicitly include exact-author conversation-comment waits and continue excluding arbitrary comments.
3. Add a concise predicate-catalog row and registration example to `pr-signals.md`.
4. Build MCP and rerun its contract test to GREEN.

### Task 4: Regression and quality verification

**Files:** All modified files.

1. Run targeted API and MCP tests:

```bash
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api build
node --test packages/api/test/review-feedback-router.test.js packages/api/test/scheduler/review-feedback-spec.test.js packages/api/test/f280-pr-wait-contract.test.js
pnpm --dir packages/mcp-server build
node --test packages/mcp-server/test/f280-register-pr-wait-contract.test.js
```

2. Format and lint only the touched files using the repository-confirmed formatter:

```bash
pnpm biome check --write packages/shared/src/types/github-wait.ts packages/api/src/domains/github-signals/GitHubWaitPredicateCatalog.ts packages/api/src/infrastructure/email/ReviewFeedbackRouter.ts packages/api/test/review-feedback-router.test.js packages/api/test/scheduler/review-feedback-spec.test.js packages/mcp-server/src/tools/callback-tools.ts packages/mcp-server/test/f280-register-pr-wait-contract.test.js cat-cafe-skills/refs/pr-signals.md feature-specs/2026-08-20-pr-conversation-comment-wait.md
```

3. Run `pnpm check` because the change touches an MCP description and first-party callback surface.
4. Inspect `git diff --check`, `git status --short`, and the complete diff.

### Task 5: Commit and fork PR

1. Commit code, tests, docs, and plan together with a Why body and thread provenance.
2. Push `fix/1377-pr-conversation-comment-wait` to `origin`.
3. Open a PR from the fork branch to `mindfn/clowder-ai:develop_base`, linking upstream issue #1377.
4. Register bounded PR tracking for exact review/CI truth after grounding the PR object and owner.
5. Route the exact HEAD to a non-author cross-family reviewer.
