import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { GitHubWaitLifecycleService } from '../dist/domains/github-signals/GitHubWaitLifecycleService.js';
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { CiCdRouter } from '../dist/infrastructure/email/CiCdRouter.js';
import { connectorDeliveryHarness } from './helpers/connector-delivery-harness.js';

for (const bucket of ['pass', 'fail'])
  test(`CI ${bucket} reaches its original thread and wakes once, fenced to the waited HEAD`, async () => {
    const log = { info() {}, warn() {}, error() {} };
    const taskStore = new TaskStore();
    const delivery = connectorDeliveryHarness();
    const { wakes } = delivery;
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
      deliveryDeps: delivery.deliveryDeps,
      eventLog: new MemoryWaitLifecycleEventLog(),
      now: () => 500,
      log,
    });
    let registerDuringProjection = false;
    const router = new CiCdRouter({
      taskStore,
      deliveryDeps: delivery.deliveryDeps,
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
    const obsoleteWakes = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: router,
      log,
      invokeTrigger: {
        trigger: async (...args) => {
          obsoleteWakes.push(args);
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
    assert.equal(delivery.admitted('original-thread', 'user-1').length, 1);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].threadId, 'original-thread');
    assert.equal(wakes[0].catId, 'codex61-sol');
    assert.equal(delivery.admitted('original-thread', 'user-1')[0].priority, bucket === 'fail' ? 'urgent' : 'normal');

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
    assert.equal(delivery.admitted('original-thread', 'user-1').length, 2);
    registerDuringProjection = true;
    await assert.rejects(tick, /Stale CI snapshot/);
    assert.equal(wakes.length, 2, 'a new wait registered during routing also fences the old snapshot');
    assert.equal((await taskStore.get(task.id)).automationState.await.baseline.headSha, 'head-c');
    assert.deepEqual(obsoleteWakes, [], 'Queue admission is the only wake path');
    assert.equal(delivery.admitted('original-thread', 'user-1').length, 2);
    assert.deepEqual(delivery.admitted('original-thread', 'other-user'), []);
  });

for (const priority of ['urgent', 'normal']) {
  for (const recovery of ['recovery', 'later observation']) {
    test(`pending ${priority} CI outcome retains urgency through ${recovery}`, async () => {
      const taskStore = new TaskStore();
      const delivery = connectorDeliveryHarness();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#8',
        threadId: 'original-thread',
        title: 'CI outbox recovery',
        ownerCatId: 'codex61-sol',
        createdBy: 'codex61-sol',
        userId: 'user-1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#8',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'head-a', ci: { bucket: 'pending', fingerprint: 'before' } },
            // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract.
            continuation: { when: [{ kind: 'pr_ci_terminal' }], then: 'Read CI.' },
            createdAt: 100,
          },
        },
      });
      const options = {
        taskStore,
        deliveryDeps: delivery.deliveryDeps,
        log: { info() {}, warn() {}, error() {} },
        now: () => 500,
      };
      const lifecycle = new GitHubWaitLifecycleService(options);
      const facts = {
        headSha: 'head-a',
        ci: {
          bucket: priority === 'urgent' ? 'fail' : 'pass',
          fingerprint: 'after',
          blockerCount: priority === 'urgent' ? 1 : 0,
        },
      };
      const pending = await lifecycle.observe({
        taskId: task.id,
        facts,
        deliveryPriority: priority,
        deferDelivery: true,
      });
      assert.equal(pending.kind, 'pending_delivery');
      assert.equal(delivery.wakes.length, 0);
      // A new service reads only the stored outcome; this is not the original call's in-memory hint.
      const reopened = new GitHubWaitLifecycleService(options);
      if (recovery === 'recovery') await reopened.recoverOutcome(task.id);
      else
        await reopened.observe({
          taskId: task.id,
          facts,
          deliveryPriority: priority === 'urgent' ? 'normal' : 'urgent',
        });
      assert.equal(delivery.admitted('original-thread', 'user-1')[0].priority, priority);
      assert.equal(delivery.wakes.length, 1);
      await reopened.recoverOutcome(task.id);
      assert.equal(delivery.wakes.length, 1, 'recovery replay must not wake twice');
    });
  }
}
