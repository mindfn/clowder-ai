import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * #1392 AC-2: a subject's terminal outcome must not outrun its final collection.
 *
 * A merged PR or a closed issue is polled one last time: the terminal outcome marks the task done,
 * and a done task is never polled again. Each collected comment is appended to the community event
 * log before it may be delivered; an append that fails holds that comment back for the next poll.
 * But the same poll still carried the terminal state into the lifecycle, so the task ended with the
 * held-back comment undelivered — and the next poll that would have retried it never came.
 *
 * Real collectors and lifecycle; GitHub and the stores are in memory, and one event-log append
 * fails once.
 */
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');

const log = { info() {}, warn() {}, error() {} };

/** An event log whose append for one comment fails the first time, as a transient store error would. */
function eventLogFailingOnceFor(commentId) {
  const events = [];
  let failed = false;
  return {
    events,
    async append(event) {
      if (!failed && event.payload?.commentId === commentId) {
        failed = true;
        throw new Error('event log unavailable');
      }
      if (events.some((existing) => existing.sourceEventId === event.sourceEventId)) return { appended: false };
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    async read(subjectKey) {
      return events.filter((event) => event.subjectKey === subjectKey);
    },
  };
}

async function poll(spec) {
  const gate = await spec.admission.gate();
  for (const item of gate.run ? gate.workItems : []) await spec.run.execute(item.signal, item.subjectKey, {});
}

describe('#1392 AC-2 — a merged PR is not closed out before its last comments are collected', () => {
  const HEAD = 'aaaa1111';
  const SUBJECT = 'pr:owner/repo#7';

  function conversationComment(id) {
    return {
      id,
      author: 'maintainer',
      body: 'one more thing',
      createdAt: '2026-09-25T00:00:00Z',
      commentType: 'conversation',
    };
  }

  async function mergedPr() {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: SUBJECT,
      threadId: 'thread_pr',
      title: 'PR tracking: owner/repo#7',
      ownerCatId: 'opus',
      why: 'test',
      createdBy: 'opus',
      userId: 'user_1',
      automationState: {
        ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pass`, lastBucket: 'pass' },
        review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 30, lastDecisionCursor: 40 },
        await: {
          v: 1,
          generation: 1,
          subjectRef: SUBJECT,
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: {
            capturedAt: 100,
            headSha: HEAD,
            review: { inlineCommentCursor: 10, conversationCommentCursor: 30, decisionCursor: 40 },
          },
          continuation: {
            when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] }],
            // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
            then: 'Answer the maintainer.',
          },
          createdAt: 100,
        },
      },
    });
    const lifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
    const comments = [conversationComment(31), conversationComment(32)];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      fetchPrMetadata: async () => ({ headSha: HEAD, prState: 'merged' }),
      fetchComments: async (_repo, _pr, cursors) => comments.filter((c) => c.id > cursors[c.commentType]),
      fetchReviews: async () => [],
      reviewFeedbackRouter: new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log }),
      eventLog: eventLogFailingOnceFor(32),
      log,
    });
    const contents = () => messageStore.getByThread('thread_pr').map((message) => message.content);
    return { spec, taskStore, task, contents };
  }

  it('an append that fails on the merge poll holds the close until that comment is delivered', async () => {
    const { spec, taskStore, task, contents } = await mergedPr();

    await poll(spec);
    assert.notEqual((await taskStore.get(task.id)).status, 'done', 'comment 32 is still owed, so tracking goes on');

    await poll(spec);

    const delivered = contents().join('\n');
    assert.match(delivered, /conversation comment #31 by maintainer/);
    assert.match(delivered, /conversation comment #32 by maintainer/, 'the held-back comment is not lost');
    assert.match(delivered, /merged/);
    assert.equal((await taskStore.get(task.id)).status, 'done', 'and the merge still ends tracking');
  });
});

describe('#1392 AC-2 — a closed issue is not closed out before its last comments are collected', () => {
  async function closedIssue() {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#861',
      threadId: 'thread_issue',
      title: 'Issue tracking: owner/repo#861',
      ownerCatId: 'opus',
      why: 'test',
      createdBy: 'opus',
      userId: 'user_1',
      automationState: {
        issue: { lastCommentCursor: 100, lastDeliveredCursor: 100, issueState: 'open' },
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'issue:owner/repo#861',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 1, issue: { lastCommentCursor: 100, state: 'open', authorLogin: 'author' } },
          // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
          continuation: { when: [{ kind: 'issue_comment_added' }], then: 'Reply to the issue.' },
          createdAt: 1,
        },
      },
    });
    const waitLifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
    const comments = [
      { id: 101, author: 'someone', body: 'first', createdAt: '2026-09-25T00:00:00Z' },
      { id: 102, author: 'someone', body: 'second', createdAt: '2026-09-25T00:00:01Z' },
    ];
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: { route: async () => ({ kind: 'skipped', reason: 'lifecycle owns delivery' }) },
      fetchComments: async (_repo, _issue, sinceId) => comments.filter((c) => c.id > (sinceId ?? 0)),
      fetchIssueState: async () => 'closed',
      fetchIssueMetadata: async () => ({ state: 'closed', authorLogin: 'author' }),
      eventLog: eventLogFailingOnceFor(102),
      waitLifecycle,
      log,
    });
    const contents = () => messageStore.getByThread('thread_issue').map((message) => message.content);
    return { spec, taskStore, task, contents };
  }

  it('an append that fails on the close poll holds the close until that comment is delivered', async () => {
    const { spec, taskStore, task, contents } = await closedIssue();

    await poll(spec);
    assert.notEqual((await taskStore.get(task.id)).status, 'done', 'comment 102 is still owed, so tracking goes on');

    await poll(spec);

    const delivered = contents().join('\n');
    assert.match(delivered, /issue comment #101 added by someone/);
    assert.match(delivered, /issue comment #102 added by someone/, 'the held-back comment is not lost');
    assert.match(delivered, /closed/);
    assert.equal((await taskStore.get(task.id)).status, 'done', 'and the close still ends tracking');
  });
});
