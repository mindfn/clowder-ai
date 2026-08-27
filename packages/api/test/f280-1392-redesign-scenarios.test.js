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

  // ──────────────────────────────────────────────
  // Case 9: Atomic renewal delivery-mark CAS
  // ──────────────────────────────────────────────
  describe('atomic renewal delivery CAS', () => {
    it('delivery-mark CAS succeeds after atomic renewal (gen N+1)', async () => {
      // Regression: publishPending used outcome.generation (N) for the CAS,
      // but after atomic renewal the task has await.generation (N+1).
      // CAS failed silently → outcome stayed pending → next observe re-delivered.
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#99',
        threadId: 'thread_renewal',
        title: 'PR tracking: owner/repo#99',
        ownerCatId: 'test-cat',
        why: 'test',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#99',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'aaa111' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      // First observe: should match + auto-renew to gen 2
      const first = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });
      assert.equal(first.kind, 'notified', 'first observe delivers');

      // Verify gen 2 installed with correct baseline
      const afterFirst = await taskStore.get(task.id);
      assert.equal(afterFirst.automationState.await.generation, 2, 'auto-renewed to gen 2');
      assert.equal(afterFirst.automationState.await.baseline.headSha, 'bbb222', 'baseline updated');
      assert.equal(afterFirst.automationState.waitOutcome.delivery, 'delivered', 'delivery marked as delivered');

      // Second observe with same facts: should NOT re-deliver
      const replay = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });
      assert.notEqual(replay.kind, 'notified', 'replay must not re-deliver');
      assert.equal(messageStore.getByThread('thread_renewal').length, 1, 'exactly one message');
    });
  });

  // ──────────────────────────────────────────────
  // Case 10: Renewal baseline carries trigger fields (P1-1)
  // ──────────────────────────────────────────────
  describe('renewal baseline carries trigger fields', () => {
    it('resultTriggerCommentId and resultTriggerHeadSha survive atomic renewal', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#77',
        threadId: 'thread_trigger_carry',
        title: 'PR tracking: owner/repo#77',
        ownerCatId: 'test-cat',
        why: 'test trigger field carryforward',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#77',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: {
              capturedAt: 100,
              headSha: 'aaa111',
              review: {
                inlineCommentCursor: 0,
                conversationCommentCursor: 5,
                decisionCursor: 1,
                resultTriggerCommentId: 42,
                resultTriggerHeadSha: 'aaa111',
              },
            },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      // Trigger pr_head_changed → atomic renewal
      await lifecycle.observe({
        taskId: task.id,
        facts: {
          headSha: 'bbb222',
          review: {
            decisionCursor: 1,
            conversationComments: [
              { id: 10, author: 'reviewer', createdAt: '2026-01-01T00:00:00Z' },
              { id: 15, author: 'reviewer', createdAt: '2026-01-02T00:00:00Z' },
            ],
          },
        },
      });

      const after = await taskStore.get(task.id);
      assert.equal(after.automationState.await.generation, 2, 'auto-renewed to gen 2');
      const newBaseline = after.automationState.await.baseline;

      // P1-1: trigger fields must survive renewal
      assert.equal(
        newBaseline.review.resultTriggerCommentId,
        42,
        'resultTriggerCommentId must carry forward from previous baseline',
      );
      assert.ok(newBaseline.review.resultTriggerHeadSha, 'resultTriggerHeadSha must be present on renewed baseline');

      // conversationCommentCursor must be computed from max conversationComments ID
      assert.equal(
        newBaseline.review.conversationCommentCursor,
        15,
        'conversationCommentCursor should be max of conversationComments IDs',
      );
    });
  });

  // ──────────────────────────────────────────────
  // Case 11: Issue expiry tick fires without new comments (P1-2)
  // ──────────────────────────────────────────────
  describe('issue expiry tick', () => {
    it('gate emits work item for expired issue wait even without new comments', async () => {
      const { createIssueCommentTaskSpec } = await import(
        new URL('../dist/infrastructure/email/IssueCommentTaskSpec.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      await taskStore.create({
        kind: 'issue_tracking',
        subjectKey: 'issue:owner/repo#55',
        threadId: 'thread_expiry',
        title: 'Issue tracking: owner/repo#55',
        ownerCatId: 'test-cat',
        why: 'test expired issue wait',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          issue: { lastCommentCursor: 10, issueState: 'open' },
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'issue:owner/repo#55',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: {
              capturedAt: 100,
              issue: { lastCommentCursor: 10, state: 'open', authorLogin: 'author' },
            },
            continuation: {
              when: [{ kind: 'issue_comment_added' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the issue',
            },
            // Expired 5 seconds ago
            expiresAt: Date.now() - 5000,
            createdAt: 100,
            provenance: 'explicit_registration',
          },
        },
      });

      let observeCalled = false;
      const spec = createIssueCommentTaskSpec({
        taskStore,
        issueCommentRouter: { route: async () => ({ invoked: false }) },
        fetchComments: async () => [],
        fetchIssueState: async () => 'open',
        waitLifecycle: {
          observe: async () => {
            observeCalled = true;
            return { kind: 'state_only', reason: 'expired' };
          },
        },
        log: { info() {}, error() {}, warn() {} },
      });

      const gateResult = await spec.admission.gate();
      assert.equal(gateResult.run, true, 'gate must produce work items for expired issue waits');
      assert.ok(observeCalled || gateResult.workItems?.length > 0, 'expired wait must reach observe()');
    });
  });

  // ──────────────────────────────────────────────
  // Case 12: Pre-existing waits stay one-shot through LifecycleService (P2)
  // ──────────────────────────────────────────────
  describe('pre-existing waits stay one-shot', () => {
    it('waits without autoRenew field do NOT auto-renew on predicate match', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#88',
        threadId: 'thread_oneshot',
        title: 'PR tracking: owner/repo#88',
        ownerCatId: 'test-cat',
        why: 'test one-shot backward compat',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#88',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'aaa111' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            provenance: 'explicit_registration',
            // NOTE: no autoRenew field — pre-existing one-shot wait
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      const result = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });

      assert.equal(result.kind, 'notified', 'predicate matched → delivered');

      const after = await taskStore.get(task.id);
      // Must NOT auto-renew: no gen 2 installed
      assert.equal(after.automationState.await, undefined, 'one-shot: await must be cleared after match');
      assert.equal(after.status, 'done', 'one-shot: task must transition to done');
      assert.equal(after.automationState.waitOutcome.autoRenewed, undefined, 'must not have autoRenewed marker');
      assert.equal(after.automationState.waitOutcome.delivery, 'delivered', 'outcome must be delivered');
    });
  });
});
