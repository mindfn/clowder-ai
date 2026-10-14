import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readQueueCarrierMessages } from '../dist/domains/cats/services/agents/invocation/QueueCarrierSourceProjection.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';
import { executeTaskPipeline } from '../dist/infrastructure/scheduler/execute-pipeline.js';
import {
  createAlphaBrowserTemplate,
  supportsAlphaBrowserVerification,
} from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { fixture } from './helpers/alpha-browser-template-fixture.js';

for (const ownership of ['owner', 'guardian']) {
  test(`Alpha ${ownership} notification remains readable by its invoked owner and rejects a foreign owner`, async () => {
    const f = fixture();
    const store = new MessageStore();
    if (ownership === 'guardian') {
      const drafts = f.runtime.alphaBrowserFailureTasks;
      f.runtime.alphaBrowserFailureTasks = async () =>
        (await drafts()).map((draft) => ({ ...draft, ownerCatId: null, ownership: 'unresolved' }));
    }
    f.context.deliver = createDeliverFn({
      messageStore: store,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    await spec.run.execute('alpha', 'alpha', f.context);
    const [threadId, , userId, content, messageId] = f.triggered[0];
    const entry = { id: 'alpha-notification', threadId, userId, messageId, mergedMessageIds: [] };
    const messages = await readQueueCarrierMessages(entry, store);
    assert.equal(messages[0].userId, f.options.ownerUserId);
    assert.equal(messages[0].content, content);
    assert.equal(messages[0].source.connector, 'scheduler', 'connector identity is independent of data ownership');
    await assert.rejects(readQueueCarrierMessages({ ...entry, userId: 'foreign-owner' }, store), /out of scope/);
  });
}

for (const restriction of ['scarce', 'unavailable', 'unregistered']) {
  test(`historical ${restriction} owner is preserved but only the subscription guardian is awakened`, async () => {
    const f = fixture();
    f.params.params.guardianCatId = 'guardian';
    f.options.resolveCat = (id) => (restriction === 'unregistered' && id === 'fixture-cat' ? null : id);
    f.options.isAvailable = (id) => restriction !== 'unavailable' || id !== 'fixture-cat';
    f.options.getEngagementPolicy = (id) =>
      restriction === 'scarce' && id === 'fixture-cat' ? { quota: 'weekly_subscription_scarce' } : undefined;
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    for (let i = 0; i < 2; i++) await spec.run.execute('alpha', 'alpha', f.context);
    assert.equal(f.tasks.size, 1);
    assert.equal([...f.tasks.values()][0].ownerCatId, 'fixture-cat', 'historical ownership must not be rewritten');
    assert.deepEqual(
      f.triggered.map((args) => args[1]),
      ['guardian', 'guardian'],
    );
    assert.match(f.delivered[0].content, /guardian.*fixture-cat/u, 'the routing decision must be visible');
  });
}

test('owner eligibility is rechecked at dispatch, then replay uses the current guardian without another Task', async () => {
  const f = fixture();
  f.params.params.guardianCatId = 'guardian';
  f.options.resolveCat = (id) => id;
  let scarce = false;
  f.options.getEngagementPolicy = (id) =>
    scarce && id === 'fixture-cat' ? { quota: 'weekly_subscription_scarce' } : undefined;
  const deliver = f.context.deliver;
  f.context.deliver = async (input) => {
    const source = await deliver(input);
    scarce = true;
    return source;
  };
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /triage target changed/u);
  assert.equal(f.triggered.length, 0);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(f.tasks.size, 1);
  assert.equal(f.triggered[0][1], 'guardian');
});

test('an explicitly configured scarce guardian is preserved; an unavailable guardian cannot be awakened', async () => {
  const f = fixture();
  f.options.getEngagementPolicy = () => ({ quota: 'weekly_subscription_scarce' });
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(f.triggered[0][1], 'fixture-cat', 'explicit schedule selection is not an inferred owner');
  f.options.isAvailable = () => false;
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /guardian unavailable/u);
  assert.equal(f.triggered.length, 1);
});

test('alpha failure replay keeps one Task while allowing at-least-once owner notification', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template, 'alpha template must exist');
  const spec = template.createSpec('alpha-subscription', f.params);
  assert.equal(spec.run.overlap, 'skip');
  const admission = await spec.admission.gate({ taskId: spec.id });
  assert.equal(admission.run, true);
  for (let i = 0; i < 2; i++) await spec.run.execute(admission.workItems[0].signal, 'alpha', f.context);
  assert.equal(f.tasks.size, 1);
  const task = [...f.tasks.values()][0];
  assert.equal(task.ownerCatId, 'fixture-cat');
  assert.equal(task.userId, 'owner');
  assert.equal(task.threadId, 'gate-owner');
  assert.match(task.title, /P1/);
  assert.match(task.why, /exact-job/);
  assert.match(task.why, /git:head:docs\/feature.md/);
  assert.equal(f.delivered.length, 2);
  assert.equal(f.triggered.length, 2);
});

for (const phase of ['deliver', 'trigger']) {
  for (const ownership of ['owner', 'guardian']) {
    test(`alpha retries ${phase} failure after Task creation before settling (${ownership})`, async () => {
      const f = fixture();
      let attempts = 0,
        settled = 0;
      const run = f.runtime.runAlphaBrowserRevision;
      f.runtime.runAlphaBrowserRevision = async (input) => {
        const result = await run(input);
        settled++;
        return result;
      };
      if (ownership === 'guardian') {
        const drafts = f.runtime.alphaBrowserFailureTasks;
        f.runtime.alphaBrowserFailureTasks = async () =>
          (await drafts()).map((draft) => ({ ...draft, ownerCatId: null, ownership: 'unresolved' }));
      }
      const failOnce = async () => {
        if (++attempts === 1) throw new Error(`transient ${phase} outage`);
      };
      if (phase === 'deliver') {
        const deliver = f.context.deliver;
        f.context.deliver = async (input) => {
          await failOnce();
          return deliver(input);
        };
      } else {
        const trigger = f.context.invokeTrigger.trigger;
        f.context.invokeTrigger.trigger = async (...args) => {
          await failOnce();
          return trigger(...args);
        };
      }
      const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
      await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /transient/);
      assert.equal(settled, 0);
      assert.equal(f.tasks.size, 1);
      const taskId = [...f.tasks.values()][0].id;
      await spec.run.execute('alpha', 'alpha', f.context);
      assert.equal(settled, 1);
      assert.equal(f.tasks.size, 1);
      assert.equal([...f.tasks.values()][0].id, taskId);
      assert.equal(f.triggered.length, 1, 'owner/guardian must be awakened before settlement');
      assert.equal(f.triggered[0][1], 'fixture-cat');
      assert.equal([...f.tasks.values()][0].ownerCatId, ownership === 'owner' ? 'fixture-cat' : null);
    });
  }
}

test('a full invocation queue cannot settle a revision and can retry the existing Task', async () => {
  const f = fixture();
  let attempts = 0;
  f.context.invokeTrigger.trigger = async () => (++attempts === 1 ? 'full' : 'enqueued');
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /wake not accepted/);
  assert.equal(f.tasks.size, 1);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(attempts, 2);
  assert.equal(f.tasks.size, 1);
});

test('missing exact baseline or delivery target cannot silently start full alpha work', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template);
  for (const params of [
    { ...f.params, deliveryThreadId: null },
    { ...f.params, params: { ...f.params.params, baselineSha: 'main' } },
    { ...f.params, params: { ...f.params.params, guardianCatId: 'unknown' } },
  ]) {
    const spec = template.createSpec('alpha-subscription', params);
    assert.equal((await spec.admission.gate({ taskId: spec.id })).run, false);
  }
});

test('incomplete execution is a failed scheduler run, not a delivered verification result', async () => {
  const f = fixture();
  const runtime = await f.options.loadRuntime();
  f.options.loadRuntime = async () => ({
    ...runtime,
    runAlphaBrowserRevision: async () => ({ status: 'incomplete', headSha: 'b'.repeat(40) }),
  });
  const task = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  const rows = [];
  await executeTaskPipeline({
    task,
    ledger: { record: (row) => rows.push(row) },
    logger: { info() {}, error() {} },
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  });
  assert.equal(rows.at(-1).outcome, 'RUN_FAILED');
  assert.match(rows.at(-1).error_summary, /incomplete.*bbbbbbbb/u);
  assert.equal(f.tasks.size, 0);
});

test('Alpha browser verification is unavailable without the complete installed home runtime', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'alpha-browser-support-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, 'scripts', 'lib');
  mkdirSync(library, { recursive: true });
  const files = [
    'alpha-browser-runner.mjs',
    'alpha-browser-process.mjs',
    'alpha-browser-worker.mjs',
    'alpha-browser-checkout.mjs',
    'alpha-browser-failures.mjs',
    'gate-execution-api.mjs',
  ];
  assert.equal(supportsAlphaBrowserVerification(root), false);
  for (const file of files) writeFileSync(join(library, file), '');
  assert.equal(supportsAlphaBrowserVerification(root), true);
  for (const file of files) {
    rmSync(join(library, file));
    assert.equal(supportsAlphaBrowserVerification(root), false, `${file} is required`);
    writeFileSync(join(library, file), '');
  }
});
