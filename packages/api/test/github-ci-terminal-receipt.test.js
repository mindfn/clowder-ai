import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { GitHubWaitLifecycleService } from '../dist/domains/github-signals/GitHubWaitLifecycleService.js';
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { CiCdRouter } from '../dist/infrastructure/email/CiCdRouter.js';
import { executeTaskPipeline } from '../dist/infrastructure/scheduler/execute-pipeline.js';

const log = { info() {}, warn() {}, error() {} };
const subject = 'pr:owner/repo#7';
const poll = {
  repoFullName: 'owner/repo',
  prNumber: 7,
  headSha: 'same-head',
  prState: 'merged',
  aggregateBucket: 'pending',
  checks: [],
};

async function harness() {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const receipt = {
    v: 1,
    outcomeId: `wait:${subject}:g3:subject_terminal`,
    generation: 3,
    subjectRef: subject,
    ownerFence: { kind: 'containing_task', generation: 3 },
    reason: 'subject_terminal',
    at: 100,
    delivery: 'delivered',
    terminalSubjectState: 'merged',
    actor: { kind: 'system' },
  };
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: subject,
    threadId: 'thread-recovery',
    title: 'CI terminal recovery',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
    userId: 'test',
    automationState: {
      review: { prState: 'merged' },
      ci: { headSha: 'same-head', lastBucket: 'pending' },
      waitOutcome: receipt,
    },
  });
  await taskStore.update(task.id, { status: 'done' });
  const waitLifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
  let effects = 0;
  const cicdRouter = new CiCdRouter({
    taskStore,
    deliveryDeps: { messageStore },
    waitLifecycle,
    log,
    onPrLifecycle: (event) => {
      effects++;
      return { idempotencyKey: event.idempotencyKey };
    },
  });
  const spec = createCiCdCheckTaskSpec({
    taskStore,
    cicdRouter,
    log,
    fetchPrStatuses: async () => new Map([['owner/repo#7', poll]]),
  });
  const ledger = [];
  const tick = () =>
    executeTaskPipeline({
      task: spec,
      ledger: {
        record(row) {
          ledger.push(row);
        },
      },
      logger: log,
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
    });
  return { taskStore, messageStore, task, receipt, spec, tick, ledger, effects: () => effects };
}

test('CI completes terminal effects after review already ended the wait, then exits collection', async () => {
  const h = await harness();
  await h.tick();
  const stored = await h.taskStore.get(h.task.id);
  assert.equal(stored.automationState.ci.prState, 'merged');
  assert.ok(stored.automationState.ci.terminalEffects.completedAt);
  assert.deepEqual(stored.automationState.waitOutcome, h.receipt, 'historical delivery receipt remains intact');
  assert.equal(stored.status, 'done');
  assert.equal(h.effects(), 1);
  assert.equal(h.messageStore.getRecent().length, 0, 'no duplicate terminal notification');
  await h.tick();
  assert.equal(h.effects(), 1);
  assert.equal(h.ledger.filter((row) => row.outcome === 'RUN_DELIVERED').length, 1);
  assert.equal((await h.spec.admission.gate()).run, false);
});

test('a terminal observation losing all writes is failed and retried, never recorded as delivered', async () => {
  const h = await harness();
  const original = h.taskStore.replaceAutomationStateIfGeneration.bind(h.taskStore);
  h.taskStore.replaceAutomationStateIfGeneration = () => null;
  await h.tick();
  assert.equal(h.ledger[0].outcome, 'RUN_FAILED');
  assert.match(h.ledger[0].error_summary, /generation_changed_concurrently/);
  assert.equal(h.effects(), 0);
  h.taskStore.replaceAutomationStateIfGeneration = original;
  await h.tick();
  assert.equal(h.ledger[1].outcome, 'RUN_DELIVERED');
  assert.ok((await h.taskStore.get(h.task.id)).automationState.ci.terminalEffects.completedAt);
  assert.equal(h.effects(), 1);
});

test('issue terminal collection also preserves the generation of a completed wait receipt', async () => {
  const taskStore = new TaskStore(),
    messageStore = new MessageStore();
  const subjectRef = 'issue:owner/repo#8';
  const receipt = {
    v: 1,
    outcomeId: `wait:${subjectRef}:g4:expired`,
    generation: 4,
    subjectRef,
    ownerFence: { kind: 'containing_task', generation: 4 },
    reason: 'expired',
    at: 100,
    delivery: 'delivered',
    actor: { kind: 'system' },
  };
  const task = await taskStore.create({
    kind: 'issue_tracking',
    subjectKey: subjectRef,
    threadId: 'thread-issue',
    title: 'Issue wait',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
    userId: 'test',
    automationState: { issue: { lastCommentCursor: 10 }, waitOutcome: receipt },
  });
  await taskStore.update(task.id, { status: 'done' });
  const lifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
  const result = await lifecycle.observe({
    taskId: task.id,
    facts: {},
    subjectState: 'closed',
    collectorPatch: { issue: { lastCommentCursor: 20 } },
  });
  assert.equal(result.kind, 'state_only');
  assert.equal((await taskStore.get(task.id)).automationState.issue.lastCommentCursor, 20);
  assert.deepEqual((await taskStore.get(task.id)).automationState.waitOutcome, receipt);
  assert.equal(messageStore.getRecent().length, 0);
});
