import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { GitHubWaitLifecycleService } from '../dist/domains/github-signals/GitHubWaitLifecycleService.js';
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { CiCdRouter } from '../dist/infrastructure/email/CiCdRouter.js';

for (const bucket of ['pass', 'fail'])
  test(`CI ${bucket} reaches its original thread and wakes once, fenced to the waited HEAD`, async () => {
    const log = { info() {}, warn() {}, error() {} };
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const awaitState = (generation, headSha) => ({
      v: 1,
      generation,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation },
      baseline: { capturedAt: 100, headSha, ci: { bucket: 'pending', fingerprint: `${headSha}:pending` } },
      // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract.
      continuation: { when: [{ kind: 'pr_ci_terminal' }], then: 'Consume this PR CI result.' },
      createdAt: 100,
    });
    const task = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'original-thread',
      title: 'CI wait',
      ownerCatId: 'codex61-sol',
      createdBy: 'codex61-sol',
      userId: 'user-1',
      automationState: { await: awaitState(1, 'head-a') },
    });
    const waitLifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      eventLog: new MemoryWaitLifecycleEventLog(),
      now: () => 500,
      log,
    });
    let registerDuringProjection = false;
    const router = new CiCdRouter({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle,
      log,
      externalReviewCoordinator: {
        recordCi: async () => {
          if (!registerDuringProjection) return;
          registerDuringProjection = false;
          const current = await taskStore.get(task.id);
          await taskStore.patchAutomationState(task.id, {
            await: {
              ...awaitState(current.automationState.await.generation + 1, 'head-c'),
              baseline: {
                capturedAt: 700,
                headSha: 'head-c',
                ci: { bucket: 'pending', fingerprint: 'head-c:pending' },
              },
            },
          });
        },
      },
    });
    let headSha = 'head-a';
    const wakes = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: router,
      log,
      invokeTrigger: {
        trigger: async (...args) => {
          wakes.push(args);
        },
      },
      fetchPrStatuses: async () =>
        new Map([
          [
            'owner/repo#7',
            {
              repoFullName: 'owner/repo',
              prNumber: 7,
              headSha,
              prState: 'open',
              aggregateBucket: bucket,
              observedAt: headSha === 'head-a' ? 200 : 600,
              checkRollup: 'present',
              checks: [{ name: 'tests', bucket }],
              failureDetailsPending: bucket === 'fail',
            },
          ],
        ]),
      enrichFailureDetails: async (poll) => ({ ...poll, failureDetailsPending: false }),
    });
    const tick = async () => {
      const gate = await spec.admission.gate();
      for (const item of gate.workItems)
        await spec.run.execute(item.signal, item.subjectKey, { signal: new AbortController().signal });
    };
    await tick();
    await tick();
    assert.equal(messageStore.getByThread('original-thread').length, 1);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0][0], 'original-thread');
    assert.equal(wakes[0][1], 'codex61-sol');
    assert.equal(wakes[0][6].priority, bucket === 'fail' ? 'urgent' : 'normal');

    const current = await taskStore.get(task.id);
    await taskStore.patchAutomationState(task.id, {
      await: {
        ...awaitState(current.automationState.await.generation + 1, 'head-b'),
        baseline: { capturedAt: 500, headSha: 'head-b', ci: { bucket: 'pending', fingerprint: 'head-b:pending' } },
      },
    });
    await assert.rejects(tick, /Stale CI snapshot/);
    assert.equal(wakes.length, 1, 'old HEAD must not satisfy a wait registered for a newer HEAD');
    headSha = 'head-b';
    await tick();
    assert.equal(wakes.length, 2);
    assert.equal(messageStore.getByThread('original-thread').length, 2);
    registerDuringProjection = true;
    await assert.rejects(tick, /Stale CI snapshot/);
    assert.equal(wakes.length, 2, 'a new wait registered during routing also fences the old snapshot');
    assert.equal((await taskStore.get(task.id)).automationState.await.baseline.headSha, 'head-c');
  });
