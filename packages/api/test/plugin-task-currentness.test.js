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
import * as currentnessModule from '../dist/domains/plugin/host-surface/plugin-task-currentness.js';

const { createPluginTaskInvocationCurrentness } = currentnessModule;

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
  let taskThread = manual ? threads.create('owner', 'Chosen Task thread') : thread;
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
          requestIdentity: {
            requestId: crypto.randomUUID(),
            transportRequestId: 'test',
            method: 'POST',
            declaredPath: 'owner',
            path: 'owner',
            bodyDigest: 'a'.repeat(64),
            queryDigest: 'b'.repeat(64),
          },
        },
        () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, prepare),
      )
    : await prepare();
  taskThread = threads.get(first.threadId);
  // Explicit legacy fixture: preserve v1 receipt bytes and namespace to test its unchanged exact-revision behavior.
  const { pluginTaskAdmissionContent, pluginTaskExecutionContent, pluginTaskExecutionKey } = await import(
    '../dist/domains/plugin/host-surface/plugin-task-receipt.js'
  );
  const legacyAdmission = messages.getById(first.admissionRef.slice(8));
  const admissionData = JSON.parse(
    legacyAdmission.content.split('<plugin_task_request>\n')[1].split('\n</plugin_task_request>')[0],
  );
  const { provenance: _provenance, mode: admissionMode, ...legacyData } = admissionData;
  legacyAdmission.content = pluginTaskAdmissionContent({ ...legacyData, version: 1 }, admissionMode);
  const currentExecution = messages.getById(first.executionRef.slice(8));
  const {
    executionAuthorityRevision: _epoch,
    executionKind: _kind,
    firstAdmission: _first,
    request: _request,
    mode: executionMode,
    ...executionData
  } = JSON.parse(currentExecution.content.split('\n').slice(1).join('\n'));
  const legacyExecution = { ...executionData, version: 1 };
  const stored = await messages.appendIdempotent({
    userId: 'owner',
    threadId: source.threadId,
    catId: null,
    mentions: [],
    timestamp: 2,
    content: pluginTaskExecutionContent(legacyExecution, executionMode),
    idempotencyKey: pluginTaskExecutionKey('instance', source.id, 'codex', legacyExecution.kind),
  });
  const legacyFirst = { ...first, executionRef: `message:${stored.message.id}` };
  const next = firstExecution
    ? source
    : messages.append({ ...structuredClone(source), id: undefined, content: 'Continue report', timestamp: 2 });
  const resumed = firstExecution
    ? legacyFirst
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
  const currentnessDeps = {
    ownerUserId: 'owner',
    taskStore: tasks,
    messageStore: messages,
    threadStore: threads,
    inventory: { snapshot: async () => state },
    isCatAvailable: (id) => available && id === 'codex',
  };
  const check = createPluginTaskInvocationCurrentness(currentnessDeps);
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
    currentnessDeps,
    principal,
    tasks,
    messages,
    threads,
    thread,
    taskThread,
    source,
    next,
    first: legacyFirst,
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
      f.taskThread.participants = [];
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

test('legacy first execution passes the compiled Host reader for derived and owner-selected Task threads', async () => {
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

async function queueFixture(manual = false, firstExecution = false) {
  const f = await fixture(manual, firstExecution);
  f.trigger.queueCustody.sourceCategory = 'plugin_task';
  f.trigger.queueCustody.status = 'queued';
  delete f.trigger.queueCustody.awakenedInvocationIdByCatId;
  delete f.trigger.queueCustody.awakenedAtByCatId;
  const input = {
    messageId: f.trigger.id,
    entryId: 'entry',
    userId: 'owner',
    threadId: f.taskThread.id,
    targetCatId: 'codex',
  };
  assert.equal(typeof currentnessModule.createPluginTaskQueueAuthority, 'function', 'Host queue authority port exists');
  const authority = currentnessModule.createPluginTaskQueueAuthority(f.currentnessDeps);
  return { ...f, input, authority };
}

test('Queue preflight re-reads actual first/continuation receipts without inventing an invocation', async () => {
  for (const manual of [false, true])
    for (const first of [false, true]) {
      const f = await queueFixture(manual, first);
      const binding = await f.authority.read(f.input);
      assert.deepEqual(binding, f.principal.pluginTaskBinding);
      assert.ok(Object.isFrozen(binding));
      await assert.rejects(f.check(f.principal), /authority/);
    }
});

test('Queue preflight rejects ordinary/public/started/seen/failed/withdrawn or wrong-entry triggers', async () => {
  const mutations = [
    (f) => {
      delete f.trigger.queueCustody.sourceCategory;
    },
    (f) => {
      f.trigger.queueCustody.sourceCategory = 'connector';
    },
    (f) => {
      f.trigger.queueCustody.status = 'processing';
    },
    (f) => {
      f.trigger.queueCustody.awakenedInvocationIdByCatId = { codex: 'old' };
    },
    (f) => {
      f.trigger.queueCustody.seenByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.failedByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.withdrawnByCatIds = ['codex'];
    },
    (f) => {
      f.trigger.queueCustody.entryId = 'replacement';
    },
    (f) => {
      f.trigger.queueCustody.pluginPublicInvocation = {};
    },
    (f) => {
      f.trigger.queueCustody.targetAttempts = [{ sequence: 2, state: 'queued' }];
    },
  ];
  for (const mutate of mutations) {
    const f = await queueFixture();
    mutate(f);
    await assert.rejects(f.authority.read(f.input));
  }
});

test('Queue body is only a selector: malformed coordinates, ordinary copies and lost protected index deny', async () => {
  for (const change of [
    (f) => {
      f.trigger.content += ' ';
    },
    (f) => {
      f.trigger.content = f.trigger.content.replace('"version":1', '"version":2');
    },
    (f) => {
      f.trigger.content = f.trigger.content.replace('"version":1', '"extra":true,"version":1');
    },
    (f) => {
      f.messages.getByIdempotencyKey = async () => null;
    },
    (f) => {
      f.input.targetCatId = 'opus';
    },
    (f) => {
      f.input.userId = 'foreign';
    },
    (f) => {
      f.trigger.source = { connector: 'fake' };
    },
  ]) {
    const f = await queueFixture();
    change(f);
    await assert.rejects(f.authority.read(f.input));
  }
});

test('Queue preflight rejects live Task/source/installation changes and async custody drift', async () => {
  for (const change of [
    (f) => {
      f.task.entrustedWork.revision++;
    },
    (f) => {
      f.next.extra.pluginMessage.revision++;
    },
    (f) => {
      f.state.instances[0].activationState = 'disabled';
    },
    (f) => {
      f.state.grants[0].grantRevision++;
    },
    (f) => {
      f.unavailable();
    },
  ]) {
    const f = await queueFixture();
    change(f);
    await assert.rejects(f.authority.read(f.input));
  }
  const f = await queueFixture();
  const get = f.messages.getById.bind(f.messages);
  let reads = 0;
  f.messages.getById = async (id) => {
    if (id === f.trigger.id && ++reads === 3) f.trigger.queueCustody.entryId = 'replacement';
    return get(id);
  };
  await assert.rejects(f.authority.read(f.input));
});

test('Queue child binding uses real custody CAS, exact-child reread and preserves original Task', async () => {
  const f = await queueFixture(true);
  const binding = await f.authority.read(f.input);
  const original = structuredClone(f.task);
  const result = await f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' });
  assert.equal(result.kind, 'bound');
  assert.equal(result.custody.status, 'processing');
  assert.equal(result.custody.awakenedInvocationIdByCatId.codex, 'inv');
  assert.equal(result.custody.targetAttempts[0].invocationId, 'inv');
  await f.check(f.principal);
  assert.deepEqual(f.task, original);
  await assert.rejects(f.authority.bindChild({ ...f.input, binding, invocationId: 'other' }));
  await assert.rejects(f.authority.read(f.input));
});

test('Concurrent Queue children cannot both bind the same execution', async () => {
  const f = await queueFixture();
  const binding = await f.authority.read(f.input);
  const results = await Promise.allSettled(
    ['inv', 'other'].map((invocationId) => f.authority.bindChild({ ...f.input, binding, invocationId })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.trigger.queueCustody.revision, 2);
});

test('Queue CAS lost response and post-write revocation never return a successful launch authorization', async () => {
  for (const mode of ['lost_response', 'revoked']) {
    const f = await queueFixture();
    const binding = await f.authority.read(f.input);
    const cas = f.messages.transitionQueueCustody.bind(f.messages);
    f.messages.transitionQueueCustody = async (...args) => {
      const result = await cas(...args);
      if (mode === 'lost_response') throw new Error('lost response');
      f.task.entrustedWork.revision++;
      return result;
    };
    await assert.rejects(f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' }));
    assert.equal(f.trigger.queueCustody.awakenedInvocationIdByCatId.codex, 'inv');
    await assert.rejects(f.authority.read(f.input));
  }
});

test('Queue selectors and expected binding are frozen before asynchronous reads', async () => {
  const f = await queueFixture();
  const binding = structuredClone(await f.authority.read(f.input));
  const input = { ...f.input, binding, invocationId: 'inv' };
  const get = f.messages.getById.bind(f.messages);
  let changed = false;
  f.messages.getById = async (id) => {
    if (!changed) {
      changed = true;
      input.invocationId = 'foreign';
      input.targetCatId = 'opus';
      binding.taskId = 'foreign';
    }
    return get(id);
  };
  const result = await f.authority.bindChild(input);
  assert.equal(result.custody.awakenedInvocationIdByCatId.codex, 'inv');
  await f.check(f.principal);
});

test('Queue expected binding cannot substitute another execution, and the checked custody revision is the CAS input', async () => {
  const f = await queueFixture();
  const binding = await f.authority.read(f.input);
  await assert.rejects(
    f.authority.bindChild({
      ...f.input,
      binding: { ...binding, executionRef: 'message:foreign' },
      invocationId: 'inv',
    }),
  );
  const cas = f.messages.transitionQueueCustody.bind(f.messages);
  let seenRevision;
  f.messages.transitionQueueCustody = (id, args) => {
    seenRevision = args.expectedRevision;
    f.trigger.queueCustody.revision++;
    return cas(id, args);
  };
  await assert.rejects(f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' }));
  assert.equal(seenRevision, 1);
  assert.equal(f.trigger.queueCustody.awakenedInvocationIdByCatId, undefined);
});

for (const operation of ['read', 'bindChild']) {
  test(`R2 Task Queue ${operation} rejects per-target carrier state before any CAS`, async () => {
    const f = await queueFixture();
    const binding = await f.authority.read(f.input);
    f.trigger.queueCustody.carrierStateByTargetCatId = { codex: { status: 'queued' } };
    let writes = 0;
    const cas = f.messages.transitionQueueCustody.bind(f.messages);
    f.messages.transitionQueueCustody = (...args) => {
      writes++;
      return cas(...args);
    };
    await assert.rejects(
      operation === 'read'
        ? f.authority.read(f.input)
        : f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' }),
    );
    assert.equal(writes, 0);
    assert.equal(f.trigger.queueCustody.status, 'queued');
  });
}

test('R2 Task currentness rejects per-target state introduced after the child CAS', async () => {
  const f = await queueFixture();
  const binding = await f.authority.read(f.input);
  await f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' });
  f.trigger.queueCustody.carrierStateByTargetCatId = { codex: { status: 'queued' } };
  await assert.rejects(f.check(f.principal));
});

test('R2 bound Task custody is not queued by the real startup projection', async () => {
  const { queuedCarrierEntryIds } = await import(
    '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCarrierProjection.js'
  );
  const { buildQueueEntry } = await import(
    '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js'
  );
  const f = await queueFixture();
  assert.deepEqual(queuedCarrierEntryIds(f.trigger), ['entry']);
  const binding = await f.authority.read(f.input);
  await f.authority.bindChild({ ...f.input, binding, invocationId: 'inv' });
  assert.deepEqual(queuedCarrierEntryIds(f.trigger), []);
  assert.throws(() => buildQueueEntry([f.trigger], 'entry'), /no target|Task Queue custody rejected/);
});

async function runTaskQueue({
  fail = false,
  lostCas = false,
  revoke = false,
  manual = false,
  first = true,
  missingPort = false,
  silent = false,
  parentState,
  parentMismatch = false,
  fullStartup = false,
  parentClaimLost = false,
  preclaimFence,
} = {}) {
  const f = await queueFixture(manual, first);
  const [
    { InvocationQueue },
    { QueueProcessor },
    { InvocationTracker },
    { InvocationRecordStore },
    { InMemoryTurnExecutionStore },
    { CallbackAuthTurnExecutionLifecycle },
    { AgentRegistry },
    { AgentRouter },
    { QueuedMessageCustodyCoordinator },
    { buildQueueEntry },
    { createTaskQueueRoute },
  ] = await Promise.all([
    import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js'),
    import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js'),
    import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'),
    import('../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'),
    import('../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js'),
    import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
    import('../dist/domains/cats/services/agents/routing/AgentRouter.js'),
    import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
    import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js'),
    import('../src/domains/plugin/carrier/task-queue-route.ts'),
  ]);
  const q = new InvocationQueue(),
    entry = buildQueueEntry([f.trigger], 'entry');
  const records = new InvocationRecordStore();
  const parentBefore = [];
  if (parentState) {
    const create = records.create.bind(records);
    let seeded = false;
    records.create = async (input) => {
      if (!seeded) {
        seeded = true;
        const first = await create({ ...input, ...(parentMismatch ? { targetCats: ['opus'] } : {}) });
        if (parentState === 'succeeded') await records.update(first.invocationId, { status: 'running' });
        if (parentState !== 'queued') assert.ok(await records.update(first.invocationId, { status: parentState }));
        parentBefore.push(structuredClone(await records.get(first.invocationId)));
      }
      return create(input);
    };
  }
  if (parentClaimLost) {
    const update = records.update.bind(records);
    records.update = async (id, input) => {
      if (input.status === 'running' && input.expectedStatus) {
        await update(id, { status: 'running' });
        parentBefore[0] = structuredClone(await records.get(id));
        return null;
      }
      return update(id, input);
    };
  }
  let startup;
  if (fullStartup) {
    const { QueuedMessageCustodyStartupReconciler } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'
    );
    f.messages.scanByDeliveryStatus = () => [f.trigger.id]; // memory store omits the Redis scan port
    startup = await new QueuedMessageCustodyStartupReconciler({
      messageStore: f.messages,
      invocationRecordStore: records,
      invocationQueue: q,
      log: { info() {}, warn() {} },
    }).reconcile();
  } else q.restoreDurableEntry(entry);
  const turns = new InMemoryTurnExecutionStore(),
    registry = new InvocationRegistry({ turnExecutionStore: turns, assertPluginTaskCurrent: f.check });
  const state = {
    starts: 0,
    ownerReads: 0,
    childId: undefined,
    errors: [],
    egress: [],
    visible: [],
    parentCleanup: [],
    queueUpdates: [],
  };
  const agents = new AgentRegistry();
  agents.register('codex', {
    supportsPluginTaskLaunch: () => true,
    supportsToolExecutionPolicy: () => false,
    async *invoke() {
      state.starts++;
      if (!silent) yield { type: 'text', catId: 'codex', content: 'task output', timestamp: 1 };
      yield fail
        ? { type: 'error', catId: 'codex', error: 'fixture failed', timestamp: 2 }
        : { type: 'done', catId: 'codex', timestamp: 2 };
    },
  });
  const router = new AgentRouter({
    agentRegistry: agents,
    registry,
    messageStore: f.messages,
    sessionStore: {},
    turnExecutionStore: new CallbackAuthTurnExecutionLifecycle(turns, registry),
    threadStore: {
      get() {
        state.ownerReads++;
        throw Error('ordinary owner history');
      },
    },
  });
  const execution = {
    async prepare(input) {
      state.childId = input.invocationId;
      const record = await registry.getRecord(input.invocationId);
      assert.equal(f.messages.getById(f.trigger.id).queueCustody.awakenedInvocationIdByCatId.codex, input.invocationId);
      assert.equal((await registry.verifyLatest(input.invocationId, record.callbackToken)).ok, true);
      return {
        source: { messageId: f.trigger.id, content: 'Host Task' },
        launch: {
          server: { name: 'task', command: '/fixture/not-run', args: [], env: {}, transport: 'stdio' },
          sandbox: {
            kind: 'entrusted_work',
            workspaceRoot: '/fixture/task',
            runtimeSkillsRoot: '/fixture/skills',
            taskBinding: f.principal.pluginTaskBinding,
          },
          assertCurrent: async () => f.check({ ...f.principal, invocationId: input.invocationId }),
        },
        dispose() {},
      };
    },
  };
  const route = createTaskQueueRoute(
    q,
    () => f.authority,
    () => ({
      async resolveTaskInvocationPolicy(_b, check) {
        await check();
        if (revoke) f.task.entrustedWork.closure.state = 'completed';
        await check();
        return f.principal.toolExecutionPolicy;
      },
    }),
    execution,
  );
  if (lostCas) {
    let lost = false;
    const transition = f.messages.transitionQueueCustody.bind(f.messages);
    f.messages.transitionQueueCustody = (id, input) => {
      const result = transition(id, input);
      if (!lost && input.next.awakenedInvocationIdByCatId?.codex) {
        lost = true;
        throw Error('lost CAS response');
      }
      return result;
    };
  }
  const custody = new QueuedMessageCustodyCoordinator({ messageStore: f.messages });
  const processor = new QueueProcessor({
    queue: q,
    messageStore: f.messages,
    queueCustodyCoordinator: custody,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: records,
    turnExecutionStore: turns,
    taskInvocationRoute: missingPort ? undefined : route,
    outboundHook: {
      async deliver(...args) {
        state.egress.push(['deliver', ...args]);
      },
    },
    streamingHook: Object.fromEntries(
      ['onStreamStart', 'onStreamChunk', 'onStreamEnd', 'cleanupPlaceholders', 'notifyDeliveryBatchDone'].map(
        (name) => [
          name,
          async (...args) => {
            state.egress.push([name, ...args]);
          },
        ],
      ),
    ),
    threadMetaLookup() {
      state.egress.push(['threadMeta']);
      return {};
    },
    router: { routeExecution: (...args) => router.routeExecution(...args), async ackCollectedCursors() {} },
    socketManager: {
      broadcastAgentMessage(message) {
        state.visible.push(message);
        if (message.type === 'error') state.errors.push(message);
      },
      broadcastToRoom() {},
      emitToUser(_userId, event, payload) {
        if (event === 'queue_updated') state.queueUpdates.push(payload);
      },
    },
    log: {
      info() {},
      warn() {},
      error(...args) {
        state.errors.push(args.map((arg) => (arg?.err ? { ...arg, err: arg.err.stack } : arg)));
      },
    },
  });
  state.completions = [];
  processor.registerEntryCompleteHook('entry', (...args) => state.completions.push(args));
  if (preclaimFence === 'reservation') processor.bindProcessingSlotInvocation = () => false;
  if (preclaimFence === 'target') processor.reservedTargetStartBlocker = () => 'target_busy';
  if (preclaimFence === 'session') {
    let waited = false;
    processor.deps.invocationTracker.startAll = () => null;
    processor.deps.invocationTracker.waitForSessionSealRelease = async () => {
      waited = true;
    };
    processor.reservedTargetStartBlocker = () => (waited ? 'reservation_replaced' : undefined);
  }
  const releaseParent = processor.routeChainTracker.release.bind(processor.routeChainTracker);
  processor.routeChainTracker.release = (id) => {
    if (parentBefore[0]?.id === id) state.parentCleanup.push(id);
    return releaseParent(id);
  };
  processor.sessionContinuationCoordinator = {
    async commitInvocationOutcome() {
      state.ownerReads++;
      throw Error('ordinary continuation write');
    },
    async prepareInvocationContext() {
      state.ownerReads++;
      throw Error('ordinary continuation read');
    },
  };
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const complete = processor.onInvocationComplete.bind(processor);
  processor.onInvocationComplete = async (...args) => {
    await complete(...args);
    settle(args[2]);
  };
  await processor.resumeAfterStartup(f.taskThread.id, 'owner');
  let timer;
  const status = await Promise.race([
    done,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('not_dispatched'), 1500);
    }),
  ]);
  clearTimeout(timer);
  return { ...f, q, processor, registry, turns, records, parentBefore, startup, result: state, status };
}

test('real Task Queue recovery binds one canonical child before restricted provider and settles custody', async () => {
  const f = await runTaskQueue();
  assert.equal(f.status, 'succeeded', JSON.stringify(f.result.errors));
  assert.equal(f.result.starts, 1);
  assert.equal(f.result.ownerReads, 0);
  const c = f.messages.getById(f.trigger.id).queueCustody;
  assert.equal(c.targetOutcomeByCatId.codex.invocationId, f.result.childId);
  assert.equal(c.targetOutcomeByCatId.codex.disposition, 'completed_with_turn');
  await f.processor.tryAutoExecute(f.taskThread.id);
  assert.equal(f.result.starts, 1);
});
test('real Task Queue provider failure retains its child and never retries ordinarily', async () => {
  const f = await runTaskQueue({ fail: true });
  assert.equal(f.status, 'failed');
  assert.equal(f.result.starts, 1);
  assert.equal(f.result.ownerReads, 0);
  assert.equal(f.q.retryFailedTarget(f.taskThread.id, 'owner', 'entry', 'codex'), null);
  assert.equal(f.messages.getByThread(f.taskThread.id).filter((m) => m.catId === 'codex').length, 0);
});
test('real Task Queue lost child CAS response retires credentials and never starts provider', async () => {
  const f = await runTaskQueue({ lostCas: true });
  assert.equal(f.status, 'failed');
  assert.equal(f.result.starts, 0);
  const attempts = f.messages.getById(f.trigger.id).queueCustody.targetAttempts;
  assert.equal(attempts.length, 1);
  const child = attempts[0].invocationId;
  assert.ok(child);
  const record = await f.registry.getRecord(child);
  assert.notEqual(record.state, 'active');
  await f.processor.tryAutoExecute(f.taskThread.id);
  assert.equal(f.result.starts, 0);
});
test('real Task Queue revoke before registration never reads owner context or starts provider', async () => {
  const f = await runTaskQueue({ revoke: true });
  assert.equal(f.status, 'failed');
  assert.equal(f.result.starts, 0);
  assert.equal(f.result.ownerReads, 0);
  assert.equal(f.messages.getById(f.trigger.id).queueCustody.awakenedInvocationIdByCatId?.codex, undefined);
});

test('real Task Queue continuation preserves the owner-selected Task thread', async () => {
  const f = await runTaskQueue({ manual: true, first: false });
  assert.equal(f.status, 'succeeded', JSON.stringify(f.result.errors));
  assert.equal(f.result.starts, 1);
  assert.equal(f.result.ownerReads, 0);
  assert.equal((await f.registry.getRecord(f.result.childId)).threadId, f.taskThread.id);
});
test('Task Queue without its Host adapter stays queued and cannot fall through ordinary routing', async () => {
  const f = await runTaskQueue({ missingPort: true });
  assert.equal(f.status, 'not_dispatched');
  assert.equal(f.result.starts, 0);
  assert.equal(f.result.ownerReads, 0);
  assert.equal(f.q.getEntrySnapshot(f.taskThread.id, 'owner', 'entry').status, 'queued');
});

for (const [name, options] of Object.entries({
  success: {},
  failure: { fail: true },
  preflight: { revoke: true },
  silent: { silent: true },
})) {
  test(`private Task Queue ${name} never publishes through ordinary connector hooks`, async () => {
    const f = await runTaskQueue(options);
    assert.notEqual(f.status, 'not_dispatched');
    assert.deepEqual(f.result.egress, []);
    assert.equal(f.result.ownerReads, 0);
    if (name === 'success') assert.ok(f.result.visible.some((m) => m.type === 'text' && m.content === 'task output'));
  });
}

test('R2 full startup reconciler restores an unstarted private Task without ordinary carrier state', async () => {
  const f = await runTaskQueue({ fullStartup: true });
  assert.equal(f.startup.entriesRestored, 1);
  assert.equal(f.startup.messagesFailed, 0);
  assert.deepEqual(f.startup.resumeScopes, [{ threadId: f.taskThread.id, userId: 'owner' }]);
  assert.equal(f.status, 'succeeded', JSON.stringify(f.result.errors));
  assert.equal(f.result.starts, 1);
  assert.equal(f.messages.getById(f.trigger.id).queueCustody.carrierStateByTargetCatId, undefined);
});
for (const parentState of ['queued', 'failed']) {
  test(`R2 Task parent ${parentState} survives a crash before child CAS and is reused exactly`, async () => {
    const f = await runTaskQueue({ parentState });
    assert.equal(f.status, 'succeeded', JSON.stringify(f.result.errors));
    assert.equal(f.result.starts, 1);
    assert.equal((await f.records.get(f.parentBefore[0].id)).status, 'succeeded');
    assert.equal(f.messages.getById(f.trigger.id).queueCustody.targetAttempts.length, 1);
  });
}
for (const [name, options] of Object.entries({
  mismatch: { parentState: 'queued', parentMismatch: true },
  running: { parentState: 'running' },
  succeeded: { parentState: 'succeeded' },
  claimLost: { parentState: 'queued', parentClaimLost: true },
})) {
  test(`R2 Task refuses ${name} parent without consuming custody or rewriting the record`, async () => {
    const f = await runTaskQueue(options);
    assert.equal(f.result.starts, 0);
    assert.equal(f.status, 'failed');
    assert.equal(f.q.getEntrySnapshot(f.taskThread.id, 'owner', 'entry')?.status, 'queued');
    assert.equal(f.messages.getById(f.trigger.id).queueCustody.status, 'queued');
    assert.deepEqual(await f.records.get(f.parentBefore[0].id), f.parentBefore[0]);
    assert.deepEqual(f.result.parentCleanup, []);
  });
}

for (const parentState of ['queued', 'failed']) {
  for (const preclaimFence of ['reservation', 'target', 'session']) {
    test(`R3 unclaimed ${parentState} parent is immutable across ${preclaimFence} fence`, async () => {
      const f = await runTaskQueue({ parentState, preclaimFence });
      assert.equal(f.result.starts, 0);
      assert.deepEqual(await f.records.get(f.parentBefore[0].id), f.parentBefore[0]);
      assert.equal(f.messages.getById(f.trigger.id).queueCustody.status, 'queued');
      assert.equal(f.messages.getById(f.trigger.id).queueCustody.awakenedInvocationIdByCatId?.codex, undefined);
      assert.deepEqual(f.result.parentCleanup, []);
      assert.deepEqual(f.result.egress, []);
      assert.deepEqual(f.result.visible, []);
      assert.deepEqual(f.result.errors, []);
      assert.deepEqual(f.result.completions, []);
      assert.equal(f.processor.entryCompleteHooks.has('entry'), true);
      assert.ok(f.result.queueUpdates.length > 0);
      assert.equal(
        f.result.queueUpdates.some((update) => update.action === 'completed'),
        false,
      );
    });
  }
}
