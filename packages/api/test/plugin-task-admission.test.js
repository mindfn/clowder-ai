import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.ts';
import { createPluginTaskAdmissionServices } from '../src/domains/plugin/host-surface/plugin-task-admission.ts';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/plugin-task-host.ts';

async function fixture(grants = ['task.admitEntrusted']) {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const thread = await threads.create('owner', 'Admission');
  threads.addParticipants(thread.id, ['codex']);
  const source = messages.append({
    userId: 'owner',
    threadId: thread.id,
    catId: null,
    content: 'Please produce the report.',
    mentions: [],
    timestamp: 1,
    source: { connector: 'neutral', label: 'Neutral', icon: 'message' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  let active = true;
  const deps = {
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: grants,
    taskStore: tasks,
    threadStore: threads,
    readThreadStore: threads,
    assertCurrent: async () => {
      assert.ok(active, 'activation expired');
    },
    admission: {
      messageStore: messages,
      isCatAvailable: (id) => id === 'codex',
      assertCurrent: async () => {
        assert.ok(active, 'admission grant expired');
      },
    },
  };
  const host = createPluginTaskHost(deps);
  assert.equal(typeof host.prepareEntrusted, 'function', 'Task Host must expose actual entrusted admission');
  const input = {
    sourceMessageId: source.id,
    targetCatId: 'codex',
    destination: { kind: 'derived_from_source' },
    subject: {
      kind: 'new',
      title: 'Report',
      intendedOutcome: 'A report',
      closure: { condition: 'Report accepted', expectedSignal: 'accepted' },
    },
  };
  const owner = (operation, run) =>
    withPluginOwnerRequest(
      {
        pluginId: 'neutral',
        contributionId: 'owner',
        userId: 'owner',
        operation,
        signal: new AbortController().signal,
      },
      () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, run),
    );
  return {
    messages,
    tasks,
    threads,
    thread,
    source,
    deps,
    host,
    input,
    owner,
    expire: () => {
      active = false;
    },
  };
}

test('background admission uses actual Lifecycle and durable receipt, is idempotent, and does not dispatch', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  assert.equal(first.result, 'admitted');
  const task = f.tasks.get(first.taskRef.slice('task:work:'.length));
  assert.equal(task.userId, 'owner');
  assert.equal(task.ownerCatId, 'codex');
  assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${f.source.id}`]);
  assert.equal(task.entrustedWork.admission.authorityRef, first.admissionRef);
  const receipt = f.messages.getById(first.admissionRef.slice('message:'.length));
  assert.equal(receipt.source, undefined);
  assert.equal(receipt.queueCustody, undefined);
  assert.match(receipt.content, /plugin_policy/);
  assert.doesNotMatch(receipt.content, /strict|Service verified/);
  const again = await createPluginTaskHost(f.deps).prepareEntrusted(f.input);
  assert.equal(again.taskRef, first.taskRef);
  assert.equal(again.admissionRef, first.admissionRef);
  assert.equal(f.tasks.listByKind('work').length, 1);
  assert.equal(first.dispatchRef, undefined, 'prepare must not invent a functioning private dispatcher');
});

test('only the explicit admission grant admits; task.read and task.write alone do not', async () => {
  for (const grants of [[], ['task.read'], ['task.write']]) {
    const f = await fixture(grants);
    await assert.rejects(() => f.host.prepareEntrusted(f.input), /task.admitEntrusted/);
    assert.equal(f.tasks.listByKind('work').length, 0);
  }
});

test('owner HTTP write preserves manual destination selection; read and background cannot select it', async () => {
  const f = await fixture();
  const target = f.threads.create('owner', 'Chosen destination');
  f.threads.addParticipants(target.id, ['codex']);
  const input = { ...f.input, destination: { kind: 'existing_thread', threadId: target.id } };
  await assert.rejects(() => f.host.prepareEntrusted(input));
  await assert.rejects(() => f.owner('read', () => f.host.prepareEntrusted(input)));
  const admitted = await f.owner('write', () => f.host.prepareEntrusted(input));
  assert.equal(admitted.threadId, target.id);
  assert.match(f.messages.getById(admitted.admissionRef.slice(8)).content, /owner_request/);
});

test('source and caller identity selectors cannot forge Host authority', async () => {
  for (const change of [{ userId: 'foreign' }, { extra: {} }, { deletedAt: 1 }, { recall: { recalledAt: 1 } }]) {
    const f = await fixture();
    Object.assign(f.source, change);
    await assert.rejects(() => f.host.prepareEntrusted(f.input));
    assert.equal(f.tasks.listByKind('work').length, 0);
  }
  const f = await fixture();
  for (const field of ['ownerUserId', 'ownerAuthProvenance', 'grant', 'pluginInstanceId'])
    await assert.rejects(() => f.host.prepareEntrusted({ ...f.input, [field]: 'forged' }));
  await assert.rejects(() =>
    withPluginCallContext(
      'instance',
      {
        userId: 'owner',
        threadId: f.thread.id,
        catId: 'codex',
        invocationId: 'inv',
        originTriggerMessageId: 'other',
        assertCurrent: async () => {},
      },
      () => f.host.prepareEntrusted(f.input),
    ),
  );
});

test('source mutation or activation revocation across asynchronous reads prevents Task admission', async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const get = f.messages.getById.bind(f.messages);
    let reads = 0;
    f.messages.getById = async (id) => {
      const result = structuredClone(get(id));
      if (id === f.source.id && ++reads === 2) {
        if (expire) f.expire();
        else result.extra.pluginMessage.revision++;
      }
      return result;
    };
    await assert.rejects(() => f.host.prepareEntrusted(f.input));
    assert.equal(f.tasks.listByKind('work').length, 0);
  }
});

test('missing closure can be clarified on the same source without an admission conflict', async () => {
  const f = await fixture();
  const input = structuredClone(f.input);
  delete input.subject.closure;
  assert.equal((await f.host.prepareEntrusted(input)).result, 'needs_clarification');
  assert.equal(f.tasks.listByKind('work').length, 0);
  assert.equal((await f.host.prepareEntrusted(f.input)).result, 'admitted');
});

for (const [firstCaller, retryCaller, expectedCreator] of [
  ['plugin_policy', 'owner_request', 'system'],
  ['owner_request', 'plugin_policy', 'user'],
  ['native_request', 'owner_request', 'system'],
  ['owner_request', 'native_request', 'user'],
]) {
  test(`${firstCaller} clarification then ${retryCaller} completion preserves receipt attribution`, async () => {
    const f = await fixture();
    const run = (caller, host, input) => {
      if (caller === 'owner_request') return f.owner('write', () => host.prepareEntrusted(input));
      if (caller === 'native_request')
        return withPluginCallContext(
          'instance',
          {
            userId: 'owner',
            threadId: f.thread.id,
            catId: 'codex',
            invocationId: 'inv',
            originTriggerMessageId: f.source.id,
            toolExecutionPolicy: {
              mode: 'plugin_native',
              pluginInstanceId: 'instance',
              contributionId: 'native',
              actionMethods: ['accept'],
            },
            assertCurrent: async () => {},
            assertInvocationCurrent: async () => {},
          },
          () => host.prepareEntrusted(input),
        );
      return host.prepareEntrusted(input);
    };
    const incomplete = structuredClone(f.input);
    delete incomplete.subject.closure;
    assert.equal((await run(firstCaller, f.host, incomplete)).result, 'needs_clarification');
    assert.equal(f.tasks.listByKind('work').length, 0);
    const receipts = () =>
      f.messages.getByThread(f.thread.id).filter((m) => m.content.startsWith('Host plugin Task admission receipt.'));
    const before = receipts();
    assert.equal(before.length, 1);
    assert.ok(before[0].content.includes(`"mode":"${firstCaller}"`));
    const result = await run(retryCaller, createPluginTaskHost(f.deps), f.input);
    const task = f.tasks.get(result.taskRef.slice('task:work:'.length));
    assert.equal(task.createdBy, expectedCreator);
    assert.equal(result.admissionRef, `message:${before[0].id}`);
    assert.deepEqual(receipts(), before);
    assert.equal(f.tasks.listByKind('work').length, 1);
  });
}

test('actual native source context admits while concurrent retries keep one Task and one receipt', async () => {
  const f = await fixture();
  const context = {
    userId: 'owner',
    threadId: f.thread.id,
    catId: 'codex',
    invocationId: 'inv',
    originTriggerMessageId: f.source.id,
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['accept'],
    },
    assertCurrent: async () => {},
    assertInvocationCurrent: async () => {},
  };
  const run = () => withPluginCallContext('instance', context, () => f.host.prepareEntrusted(f.input));
  const results = await Promise.all([run(), run()]);
  assert.equal(results[0].taskRef, results[1].taskRef);
  assert.equal(results[0].admissionRef, results[1].admissionRef);
  assert.equal(f.tasks.listByKind('work').length, 1);
});

test('production admission fence binds exact package, lifecycle and grant revisions', async () => {
  const f = await fixture();
  const snapshot = {
    instances: [
      {
        pluginInstanceId: 'instance',
        packageDigest: 'digest',
        lifecycleRevision: 1,
        lifecycleState: 'installed',
        activationState: 'enabled',
        configReadiness: 'ready',
      },
    ],
    grants: [{ pluginInstanceId: 'instance', grantRevision: 1, effectiveGrants: ['task.admitEntrusted'] }],
    packages: [{ packageDigest: 'digest', packageState: 'installed' }],
  };
  for (const mutate of [
    (s) => s.grants[0].effectiveGrants.splice(0),
    (s) => {
      s.grants[0].grantRevision++;
    },
    (s) => {
      s.instances[0].lifecycleRevision++;
    },
    (s) => {
      s.instances[0].packageDigest = 'other';
    },
    (s) => {
      s.instances[0].activationState = 'disabled';
    },
    (s) => {
      s.packages[0].packageState = 'quarantined';
    },
  ]) {
    const state = structuredClone(snapshot);
    const services = await createPluginTaskAdmissionServices({
      pluginInstanceId: 'instance',
      packageDigest: 'digest',
      inventory: { snapshot: async () => state },
      messageStore: f.messages,
      assertActivation() {},
      isCatAvailable: () => true,
    });
    await services.assertCurrent();
    mutate(state);
    await assert.rejects(() => services.assertCurrent());
  }
});

test('replay refuses a changed request or closed Task and preserves the original Task', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  await assert.rejects(() =>
    f.host.prepareEntrusted({ ...f.input, subject: { ...f.input.subject, intendedOutcome: 'Different work' } }),
  );
  const task = f.tasks.get(first.taskRef.slice('task:work:'.length));
  task.entrustedWork.closure.state = 'completed';
  await assert.rejects(() => f.host.prepareEntrusted(f.input));
  assert.equal(f.tasks.listByKind('work').length, 1);
});
