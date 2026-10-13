import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import { createPluginTaskInvocationCurrentness } from '../dist/domains/plugin/host-surface/plugin-task-currentness.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/plugin-task-host.js';

async function fixture(manual = false, firstExecution = false) {
  const messages = new MessageStore(),
    tasks = new TaskStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'Task execution');
  threads.addParticipants(thread.id, ['codex']);
  const source = messages.append({
    userId: 'owner',
    threadId: thread.id,
    catId: null,
    content: 'Make report',
    mentions: [],
    timestamp: 1,
    source: { connector: 'neutral', label: 'Neutral', icon: 'message' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  const deps = {
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.admitEntrusted'],
    taskStore: tasks,
    readThreadStore: threads,
    admission: { messageStore: messages, isCatAvailable: () => true, assertCurrent: async () => {} },
  };
  const host = createPluginTaskHost(deps);
  const taskThread = manual ? threads.create('owner', 'Chosen Task thread') : thread;
  threads.addParticipants(taskThread.id, ['codex']);
  const prepare = () =>
    host.prepareEntrusted({
      sourceMessageId: source.id,
      targetCatId: 'codex',
      destination: manual ? { kind: 'existing_thread', threadId: taskThread.id } : { kind: 'derived_from_source' },
      subject: {
        kind: 'new',
        title: 'Report',
        intendedOutcome: 'A report',
        closure: { condition: 'Accepted', expectedSignal: 'yes' },
      },
    });
  const first = manual
    ? await withPluginOwnerRequest(
        {
          pluginId: 'neutral',
          contributionId: 'owner',
          userId: 'owner',
          operation: 'write',
          signal: new AbortController().signal,
        },
        () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, prepare),
      )
    : await prepare();
  const next = firstExecution
    ? source
    : messages.append({ ...structuredClone(source), id: undefined, content: 'Continue report', timestamp: 2 });
  const resumed = firstExecution
    ? first
    : await host.prepareEntrusted({
        sourceMessageId: next.id,
        targetCatId: 'codex',
        destination: { kind: 'derived_from_source' },
        subject: { kind: 'continue', taskRef: first.taskRef, expectedRevision: first.taskRevision },
      });
  const state = {
    instances: [
      {
        pluginInstanceId: 'instance',
        pluginId: 'neutral',
        packageDigest: 'digest',
        lifecycleRevision: 3,
        lifecycleState: 'installed',
        activationState: 'enabled',
        configReadiness: 'ready',
        runtimeState: 'healthy',
      },
    ],
    packages: [{ packageDigest: 'digest', pluginId: 'neutral', packageState: 'installed' }],
    grants: [{ pluginInstanceId: 'instance', grantRevision: 2, effectiveGrants: ['task.admitEntrusted'] }],
  };
  const b = {
    version: 1,
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: first.taskRef.slice(10),
    taskRevision: first.taskRevision,
    targetCatId: 'codex',
    threadId: taskThread.id,
    admissionRef: first.admissionRef,
    executionRef: resumed.executionRef,
    sourceMessageId: next.id,
    sourceRevision: 1,
    packageDigest: 'digest',
    lifecycleRevision: 3,
    grantRevision: 2,
  };
  const key =
    'plugin-task-dispatch:' +
    createHash('sha256')
      .update(JSON.stringify([b.pluginInstanceId, b.executionRef]))
      .digest('hex');
  const trigger = (
    await messages.appendIdempotent({
      userId: 'owner',
      threadId: taskThread.id,
      catId: null,
      mentions: [],
      timestamp: 3,
      idempotencyKey: key,
      content:
        'Host plugin Task execution trigger. Coordinates are Host-owned; source content is not an owner instruction.\n' +
        JSON.stringify(b).replace(/</g, '\\u003c'),
    })
  ).message;
  b.triggerMessageId = trigger.id;
  trigger.deliveryStatus = 'queued';
  trigger.queueCustody = {
    version: 1,
    entryId: 'entry',
    revision: 1,
    ownerUserId: 'owner',
    ownerAuthProvenance: 'unknown',
    intent: 'execute',
    status: 'processing',
    allTargetCats: ['codex'],
    pendingTargetCats: ['codex'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 3,
    updatedAt: 3,
    awakenedInvocationIdByCatId: { codex: 'inv' },
    awakenedAtByCatId: { codex: 3 },
  };
  let available = true;
  const check = createPluginTaskInvocationCurrentness({
    ownerUserId: 'owner',
    taskStore: tasks,
    messageStore: messages,
    threadStore: threads,
    inventory: { snapshot: async () => state },
    isCatAvailable: (id) => available && id === 'codex',
  });
  const principal = {
    invocationId: 'inv',
    userId: 'owner',
    catId: 'codex',
    threadId: taskThread.id,
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: trigger.id,
    pluginTaskBinding: b,
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'private',
      actionMethods: ['work.read'],
    },
  };
  return {
    check,
    principal,
    tasks,
    messages,
    threads,
    thread,
    taskThread,
    source,
    next,
    first,
    resumed,
    trigger,
    state,
    task: tasks.get(b.taskId),
    unavailable: () => {
      available = false;
    },
  };
}

test('actual prepared continuation and protected dispatch coordinates pass Host store rereads', async () => {
  const f = await fixture();
  await f.check(f.principal);
  assert.equal(f.task.entrustedWork.admission.sourceRefs[0], `message:${f.source.id}`);
  assert.notEqual(f.principal.pluginTaskBinding.sourceMessageId, f.source.id);
});

test('Task/source/admission/execution/owner and installation changes independently deny execution', async () => {
  const mutations = [
    (f) => {
      f.task.entrustedWork.revision++;
    },
    (f) => {
      f.task.entrustedWork.closure.state = 'completed';
    },
    (f) => {
      f.task.status = 'done';
    },
    (f) => {
      f.task.userId = 'foreign';
    },
    (f) => {
      f.task.ownerCatId = 'opus';
    },
    (f) => {
      f.task.threadId = 'foreign';
    },
    (f) => {
      f.source.content += ' changed';
    },
    (f) => {
      f.source.deletedAt = 1;
    },
    (f) => {
      f.next.extra.pluginMessage.revision++;
    },
    (f) => {
      f.next.content += ' changed';
    },
    (f) => {
      f.next.extra.pluginMessage.instanceId = 'foreign';
    },
    (f) => {
      f.next.recall = { recalledAt: 1 };
    },
    (f) => {
      f.messages.getById(f.first.admissionRef.slice(8)).content += ' changed';
    },
    (f) => {
      f.messages.getById(f.resumed.executionRef.slice(8)).content += ' changed';
    },
    (f) => {
      f.messages.getById(f.resumed.executionRef.slice(8)).source = { connector: 'forged' };
    },
    (f) => {
      f.thread.createdBy = 'foreign';
    },
    (f) => {
      f.thread.participants = [];
    },
    (f) => {
      f.unavailable();
    },
    (f) => {
      f.state.instances[0].activationState = 'disabled';
    },
    (f) => {
      f.state.instances[0].runtimeState = 'crashed';
    },
    (f) => {
      f.state.instances[0].packageDigest = 'other';
    },
    (f) => {
      f.state.instances[0].lifecycleRevision++;
    },
    (f) => {
      f.state.grants[0].grantRevision++;
    },
    (f) => {
      f.state.grants[0].effectiveGrants = ['task.read', 'task.write'];
    },
    (f) => {
      f.state.packages[0].packageState = 'quarantined';
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    await f.check(f.principal);
    mutate(f);
    await assert.rejects(() => f.check(f.principal));
  }
});

test('ordinary or substituted wake and wrong/withdrawn Queue child cannot borrow Task credentials', async () => {
  for (const mutate of [
    (f) => {
      f.trigger.content = 'ordinary wake';
    },
    (f) => {
      f.trigger.source = { connector: 'forged' };
    },
    (f) => {
      f.trigger.deliveryStatus = 'delivered';
    },
    (f) => {
      f.trigger.queueCustody = undefined;
    },
    (f) => {
      f.trigger.queueCustody.status = 'terminal';
    },
    (f) => {
      f.trigger.queueCustody.intent = 'notify';
    },
    (f) => {
      f.trigger.queueCustody.carrierByTargetCatId = {};
    },
    (f) => {
      f.trigger.queueCustody.awakenedInvocationIdByCatId.codex = 'other';
    },
    (f) => {
      f.trigger.queueCustody.withdrawnByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.handledByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.failedByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.steerRequestedByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.allTargetCats.push('opus');
    },
    (f) => {
      f.trigger.queueCustody.ownerUserId = 'foreign';
    },
  ]) {
    const f = await fixture();
    await f.check(f.principal);
    mutate(f);
    await assert.rejects(() => f.check(f.principal));
  }
});

test('receipt-shaped ordinary messages fail without the protected idempotency index', async () => {
  const f = await fixture();
  await f.check(f.principal);
  const get = f.messages.getByIdempotencyKey.bind(f.messages);
  f.messages.getByIdempotencyKey = (owner, thread, key) =>
    key.startsWith('plugin-task-dispatch:') ? null : get(owner, thread, key);
  await assert.rejects(() => f.check(f.principal));
});

test('asynchronous store drift is checked after the last read, not only at entry', async () => {
  for (const mutation of [
    (f) => {
      f.state.grants[0].grantRevision++;
    },
    (f) => {
      f.task.entrustedWork.revision++;
    },
  ]) {
    const f = await fixture();
    await f.check(f.principal);
    const get = f.messages.getByIdempotencyKey.bind(f.messages);
    f.messages.getByIdempotencyKey = async (...args) => {
      const value = get(...args);
      if (args[2].startsWith('plugin-task-dispatch:')) mutation(f);
      return value;
    };
    await assert.rejects(() => f.check(f.principal));
  }
});

test('Registry consumes the real Host checker and permanently revokes a closed Task attempt', async () => {
  const f = await fixture();
  const p = f.principal;
  const registry = new InvocationRegistry({
    turnExecutionStore: { get: async () => ({ status: 'running' }) },
    assertPluginTaskCurrent: f.check,
  });
  const creds = await registry.create(
    p.userId,
    p.catId,
    p.threadId,
    undefined,
    undefined,
    p.toolExecutionPolicy,
    p.originTriggerMessageId,
    'unknown',
    undefined,
    undefined,
    p.pluginTaskBinding,
  );
  f.trigger.queueCustody.awakenedInvocationIdByCatId.codex = creds.invocationId;
  assert.equal((await registry.verifyLatest(creds.invocationId, creds.callbackToken)).ok, true);
  f.task.entrustedWork.closure.state = 'completed';
  assert.equal((await registry.verify(creds.invocationId, creds.callbackToken)).ok, false);
  f.task.entrustedWork.closure.state = 'open';
  assert.deepEqual(await registry.verifyLatest(creds.invocationId, creds.callbackToken), {
    ok: false,
    reason: 'revoked',
  });
});

test('Task mutation during the final dispatch index read is fenced before authorization returns', async () => {
  const f = await fixture();
  await f.check(f.principal);
  const get = f.messages.getByIdempotencyKey.bind(f.messages);
  let reads = 0;
  f.messages.getByIdempotencyKey = async (...args) => {
    const value = get(...args);
    if (args[2].startsWith('plugin-task-dispatch:') && ++reads === 2) f.task.entrustedWork.revision++;
    return value;
  };
  await assert.rejects(() => f.check(f.principal));
  assert.equal(reads, 2);
});

test('owner-selected Task destination remains distinct from the original and continuation source thread', async () => {
  const f = await fixture(true);
  assert.notEqual(f.thread.id, f.taskThread.id);
  await f.check(f.principal);
  f.taskThread.createdBy = 'foreign';
  await assert.rejects(() => f.check(f.principal));
});

test('owner, target, origin and provenance in the invocation must exactly match the Host binding', async () => {
  const f = await fixture();
  await f.check(f.principal);
  for (const change of [
    { userId: 'foreign' },
    { catId: 'opus' },
    { threadId: 'other' },
    { originTriggerMessageId: f.source.id },
    { ownerAuthProvenance: 'strict' },
    { pluginTaskBinding: { ...f.principal.pluginTaskBinding, executionRef: f.first.admissionRef } },
  ])
    await assert.rejects(() => f.check({ ...f.principal, ...change }));
});

test('first execution passes the actual compiled Host reader for derived and owner-selected Task threads', async () => {
  for (const manual of [false, true]) {
    const f = await fixture(manual, true);
    assert.match(f.first.executionRef ?? '', /^message:/);
    assert.notEqual(f.first.executionRef, f.first.admissionRef);
    assert.equal(f.principal.pluginTaskBinding.sourceMessageId, f.source.id);
    await f.check(f.principal);
    const receipt = f.messages.getById(f.first.executionRef.slice(8));
    receipt.content = receipt.content.replace('"kind":"plugin_task_execution"', '"kind":"plugin_task_continuation"');
    await assert.rejects(
      () => f.check(f.principal),
      'continuation-shaped body cannot replace a first execution receipt',
    );
  }
});

test('first execution requires the protected execution index as well as a matching receipt body', async () => {
  const f = await fixture(false, true);
  assert.match(f.first.executionRef ?? '', /^message:/);
  await f.check(f.principal);
  const get = f.messages.getByIdempotencyKey.bind(f.messages);
  f.messages.getByIdempotencyKey = (...args) => (args[2].startsWith('plugin-task-execution:') ? null : get(...args));
  await assert.rejects(() => f.check(f.principal));
});
