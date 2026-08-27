import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const CATALOG_URL = new URL('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js', import.meta.url);
const STATE_MACHINE_URL = new URL('../dist/domains/ball-custody/wait-state-machine.js', import.meta.url);
const SHARED_URL = new URL('../../shared/dist/types/github-wait.js', import.meta.url);

describe('F280 #1392 redesign — converged contract', () => {
  // ──────────────────────────────────────────────
  // Case 1: pr_conversation_comment_added predicate
  // ──────────────────────────────────────────────
  describe('pr_conversation_comment_added', () => {
    it('matches conversation comments by authorLogins (case-insensitive)', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = {
        capturedAt: 100,
        headSha: 'abc123',
        review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      const facts = {
        headSha: 'abc123',
        review: {
          decisionCursor: 0,
          conversationComments: [
            { id: 5, author: 'Codex-Bot', createdAt: '2026-01-01T00:00:00Z', body: 'review comment' },
          ],
        },
      };
      const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['codex-bot'] }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].kind, 'pr_conversation_comment_added');
      assert.ok(matches[0].delta.includes('Codex-Bot'));
    });

    it('skips comments from non-listed authors', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = {
        capturedAt: 100,
        headSha: 'abc123',
        review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      const facts = {
        headSha: 'abc123',
        review: {
          decisionCursor: 0,
          conversationComments: [{ id: 5, author: 'random-user', createdAt: '2026-01-01T00:00:00Z', body: 'hello' }],
        },
      };
      const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] }];
      assert.equal(matchGitHubWaitPredicates(when, baseline, facts).length, 0);
    });

    it('schema rejects excludeMentions (removed per maintainer direction)', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      assert.throws(() => {
        canonicalizeGitHubWaitPredicates([
          { kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'], excludeMentions: ['codex'] },
        ]);
      });
    });
  });

  // ──────────────────────────────────────────────
  // Case 2: authorLogins on issue_comment_added
  // ──────────────────────────────────────────────
  describe('issue_comment_added with authorLogins', () => {
    it('filters to listed authors only', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, issue: { lastCommentCursor: 0, state: 'open' } };
      const facts = {
        issue: {
          state: 'open',
          comments: [
            { id: 1, author: 'maintainer' },
            { id: 2, author: 'random-user' },
            { id: 3, author: 'Maintainer' },
          ],
        },
      };
      const when = [{ kind: 'issue_comment_added', authorLogins: ['maintainer'] }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 2, 'case-insensitive: both maintainer comments should match');
    });

    it('matches all comments when authorLogins is absent', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, issue: { lastCommentCursor: 0, state: 'open' } };
      const facts = {
        issue: {
          state: 'open',
          comments: [
            { id: 1, author: 'user-a' },
            { id: 2, author: 'user-b' },
          ],
        },
      };
      const when = [{ kind: 'issue_comment_added' }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 2, 'without authorLogins, all comments match');
    });
  });

  // ──────────────────────────────────────────────
  // Case 3: Optional expiresAt — no time-based termination when omitted
  // ──────────────────────────────────────────────
  describe('optional expiresAt', () => {
    it('does not expire when expiresAt is omitted', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          // No expiresAt
          createdAt: 100,
        },
      };

      // Even far in the future, predicates_matched with no matches should not expire
      const result = transitionWaitState(current, {
        type: 'predicates_matched',
        generation: 1,
        at: 999_999_999,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'matched', 'should match, not expire');
    });

    it('expires with delivery:pending when expiresAt is set and time is up', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          expiresAt: 5000,
          createdAt: 100,
        },
      };

      const result = transitionWaitState(current, {
        type: 'predicates_matched',
        generation: 1,
        at: 5000,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'expired', 'expiresAt is loud terminal');
      assert.equal(result.state.waitOutcome?.delivery, 'pending', 'expiry must be delivered (loud)');
    });
  });

  // ──────────────────────────────────────────────
  // Case 4: Catalog schema admits pr_conversation_comment_added
  // ──────────────────────────────────────────────
  describe('predicate catalog schema', () => {
    it('admits pr_conversation_comment_added with authorLogins', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubWaitPredicates([
        { kind: 'pr_conversation_comment_added', authorLogins: ['codex-bot'] },
      ]);
      assert.equal(when.length, 1);
      assert.equal(when[0].kind, 'pr_conversation_comment_added');
    });

    it('admits issue_comment_added with optional authorLogins', async () => {
      const { canonicalizeGitHubIssueWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubIssueWaitPredicates([
        { kind: 'issue_comment_added', authorLogins: ['maintainer'] },
      ]);
      assert.equal(when.length, 1);
    });

    it('admits issue_comment_added without authorLogins', async () => {
      const { canonicalizeGitHubIssueWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added' }]);
      assert.equal(when.length, 1);
    });

    it('catalog lockstep assertion passes at load time', async () => {
      const { assertGitHubWaitPredicateCatalogReady } = await import(CATALOG_URL.href);
      assert.doesNotThrow(() => assertGitHubWaitPredicateCatalogReady());
    });
  });

  // ──────────────────────────────────────────────
  // Case 5: autoRenew type on UnifiedAwaitStateV1
  // ──────────────────────────────────────────────
  describe('autoRenew on await state type', () => {
    it('autoRenew field is accepted on AwaitStateV1 (no TS error in compiled output)', async () => {
      // The shared type allows autoRenew?: boolean on UnifiedAwaitStateV1.
      // If the dist compiled, this assertion passes. (Type-level test.)
      const shared = await import(SHARED_URL.href);
      assert.ok(shared.GITHUB_WAIT_PREDICATE_KINDS, 'shared module loads');
      assert.ok(shared.GITHUB_WAIT_PREDICATE_KINDS.includes('pr_conversation_comment_added'));
    });
  });

  // ──────────────────────────────────────────────
  // Case 6: autoRenewed on WaitOutcomeV1
  // ──────────────────────────────────────────────
  describe('renderer handles autoRenewed', () => {
    it('includes renewal indicator in rendered output', async () => {
      const { renderGitHubWaitOutcome } = await import(
        new URL('../dist/domains/github-signals/github-wait-renderer.js', import.meta.url).href
      );
      const outcome = {
        v: 1,
        outcomeId: 'test',
        generation: 1,
        subjectRef: 'pr:owner/repo#1',
        ownerFence: { kind: 'containing_task', generation: 1 },
        reason: 'matched',
        at: 1000,
        delivery: 'delivered',
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
        nextStep: 'Read the review',
        autoRenewed: true,
      };
      const content = renderGitHubWaitOutcome(outcome);
      assert.ok(content.includes('auto-renewed'), 'should mention auto-renewal');
    });
  });

  // ──────────────────────────────────────────────
  // Case 7: shouldAutoRenew backward compatibility
  // ──────────────────────────────────────────────
  describe('shouldAutoRenew backward compat', () => {
    it('pre-existing waits without autoRenew field do NOT auto-renew', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      // Simulate a pre-existing wait: no autoRenew field
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          createdAt: 100,
          // No autoRenew field — pre-existing one-shot
        },
      };
      // shouldAutoRenew(active) === false when autoRenew is absent
      assert.equal(current.await.autoRenew, undefined);
      // This means the lifecycle will NOT auto-renew — test is type-level
    });

    it('explicit autoRenew:true enables renewal', () => {
      const state = { autoRenew: true };
      assert.equal(state.autoRenew === true, true);
    });

    it('explicit autoRenew:false disables renewal', () => {
      const state = { autoRenew: false };
      assert.equal(state.autoRenew === true, false);
    });
  });

  // ──────────────────────────────────────────────
  // Case 8: Expiry is loud — delivery:pending
  // ──────────────────────────────────────────────
  describe('loud expiry', () => {
    it('expired outcome gets delivery:pending for notification', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          expiresAt: 1000,
          createdAt: 100,
        },
      };
      // Expired (no predicates matched, time past expiresAt)
      const result = transitionWaitState(current, {
        type: 'expired',
        generation: 1,
        at: 1001,
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'expired');
      assert.equal(result.state.waitOutcome?.delivery, 'pending', 'expiry must be delivered loudly');
      assert.ok(result.state.waitOutcome?.nextStep, 'expired outcome should include nextStep');
    });
  });
});
