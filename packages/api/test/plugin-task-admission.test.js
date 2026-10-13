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

async function continuationFixture() {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  const task = f.tasks.get(first.taskRef.slice('task:work:'.length));
  const source = f.messages.append({
    ...structuredClone(f.source),
    id: undefined,
    timestamp: 2,
    content: 'Continue the same report with the new evidence.',
  });
  assert.notEqual(source.id, f.source.id);
  const input = {
    ...f.input,
    sourceMessageId: source.id,
    subject: { kind: 'continue', taskRef: first.taskRef, expectedRevision: first.taskRevision },
  };
  return { ...f, first, task, nextSource: source, continuation: input };
}

test('continuation reuses the first Task and immutable admission with one durable execution receipt', async () => {
  const f = await continuationFixture();
  const before = structuredClone(f.task);
  const result = await f.host.prepareEntrusted(f.continuation);
  assert.equal(result.result, 'resumed');
  assert.equal(result.taskRef, f.first.taskRef);
  assert.equal(result.admissionRef, f.first.admissionRef);
  assert.ok(result.executionRef.startsWith('message:'));
  assert.notEqual(result.executionRef, result.admissionRef);
  const receipt = f.messages.getById(result.executionRef.slice(8));
  assert.equal(receipt.source, undefined);
  assert.equal(receipt.queueCustody, undefined);
  assert.match(receipt.content, /plugin_policy/);
  const repeats = await Promise.all([
    f.host.prepareEntrusted(f.continuation),
    createPluginTaskHost(f.deps).prepareEntrusted(f.continuation),
  ]);
  assert.ok(repeats.every((r) => r.executionRef === result.executionRef));
  assert.deepEqual(f.tasks.get(before.id), before);
  assert.equal(f.tasks.listByKind('work').length, 1);
});

test('background continuation returns to the first owner-selected Task thread', async () => {
  const f = await fixture();
  const target = f.threads.create('owner', 'Manually selected task thread');
  f.threads.addParticipants(target.id, ['codex']);
  const first = await f.owner('write', () =>
    f.host.prepareEntrusted({ ...f.input, destination: { kind: 'existing_thread', threadId: target.id } }),
  );
  const next = f.messages.append({ ...structuredClone(f.source), id: undefined, timestamp: 3 });
  const result = await f.host.prepareEntrusted({
    ...f.input,
    sourceMessageId: next.id,
    subject: { kind: 'continue', taskRef: first.taskRef, expectedRevision: first.taskRevision },
  });
  assert.equal(result.threadId, target.id);
  assert.equal(result.taskRef, first.taskRef);
});

test('continuation refuses stale, foreign, closed, ordinary or forged first admissions without a receipt', async () => {
  for (const mutate of [
    (f) => {
      f.continuation.subject.expectedRevision++;
    },
    (f) => {
      f.task.userId = 'foreign';
    },
    (f) => {
      f.task.ownerCatId = 'opus';
    },
    (f) => {
      f.task.entrustedWork.closure.state = 'completed';
    },
    (f) => {
      f.task.status = 'done';
    },
    (f) => {
      f.task.entrustedWork.admission.authorityRef = 'message:forged';
    },
    (f) => {
      f.source.extra.pluginMessage.instanceId = 'other';
    },
    (f) => {
      f.source.deletedAt = 1;
    },
    (f) => {
      f.messages.getById(f.first.admissionRef.slice(8)).content += 'changed';
    },
    (f) => {
      f.task.subjectKey = 'generic';
    },
  ]) {
    const f = await continuationFixture();
    mutate(f);
    const before = f.messages.getByThread(f.thread.id).length;
    await assert.rejects(
      () => f.host.prepareEntrusted(f.continuation),
      (error) => error.code === 'DELIVERY_REJECTED',
    );
    assert.equal(f.messages.getByThread(f.thread.id).length, before);
    assert.equal(f.tasks.listByKind('work').length, 1);
  }
});

test('continuation rechecks the Task after asynchronous source reads and after receipt persistence', async () => {
  for (const afterReceipt of [false, true]) {
    const f = await continuationFixture();
    let changed = false;
    if (afterReceipt) {
      const append = f.messages.appendIdempotent.bind(f.messages);
      f.messages.appendIdempotent = async (value) => {
        const result = await append(value);
        f.task.entrustedWork.revision++;
        changed = true;
        return result;
      };
    } else {
      const get = f.messages.getById.bind(f.messages);
      let reads = 0;
      f.messages.getById = async (id) => {
        const result = structuredClone(get(id));
        if (id === f.nextSource.id && ++reads === 2) {
          f.task.entrustedWork.revision++;
          changed = true;
        }
        return result;
      };
    }
    await assert.rejects(
      () => f.host.prepareEntrusted(f.continuation),
      (error) => error.code === 'DELIVERY_REJECTED',
    );
    assert.equal(changed, true, 'exercise the intended asynchronous mutation');
    assert.equal(f.tasks.listByKind('work').length, 1);
  }
});

test('one continuation source cannot select a second valid Task', async () => {
  const f = await continuationFixture();
  const accepted = await f.host.prepareEntrusted(f.continuation);
  const otherSource = f.messages.append({ ...structuredClone(f.source), id: undefined, timestamp: 4 });
  const other = await f.host.prepareEntrusted({ ...f.input, sourceMessageId: otherSource.id });
  await assert.rejects(
    () =>
      f.host.prepareEntrusted({
        ...f.continuation,
        subject: { kind: 'continue', taskRef: other.taskRef, expectedRevision: other.taskRevision },
      }),
    (error) => error.code === 'DELIVERY_REJECTED',
  );
  assert.equal((await f.host.prepareEntrusted(f.continuation)).executionRef, accepted.executionRef);
});

test('continuation rejects ordinary CRUD tasks and cannot move the admitted Task', async () => {
  const f = await continuationFixture();
  const ordinary = f.tasks.create({
    threadId: f.thread.id,
    title: 'Ordinary',
    why: '',
    createdBy: 'user',
    ownerCatId: 'codex',
    userId: 'owner',
  });
  await assert.rejects(
    () =>
      f.host.prepareEntrusted({
        ...f.continuation,
        subject: { kind: 'continue', taskRef: `task:work:${ordinary.id}`, expectedRevision: 1 },
      }),
    (error) => error.code === 'DELIVERY_REJECTED',
  );
  const target = f.threads.create('owner', 'Not the admitted destination');
  f.threads.addParticipants(target.id, ['codex']);
  await assert.rejects(
    () =>
      f.owner('write', () =>
        f.host.prepareEntrusted({ ...f.continuation, destination: { kind: 'existing_thread', threadId: target.id } }),
      ),
    (error) => error.code === 'DELIVERY_REJECTED',
  );
});

test('first preparation persists a distinct execution receipt and retry recovers it without dispatch', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  assert.match(first.executionRef ?? '', /^message:/);
  assert.notEqual(first.executionRef, first.admissionRef);
  const receipt = f.messages.getById(first.executionRef.slice(8));
  assert.match(receipt.content, /"kind":"plugin_task_execution"/);
  assert.equal(receipt.queueCustody, undefined);
  assert.equal(receipt.source, undefined);
  const task = structuredClone(f.tasks.get(first.taskRef.slice(10)));
  const results = await Promise.all([
    f.host.prepareEntrusted(f.input),
    createPluginTaskHost(f.deps).prepareEntrusted(f.input),
  ]);
  assert.ok(results.every((r) => r.executionRef === first.executionRef));
  assert.deepEqual(f.tasks.get(task.id), task);
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((m) => m.content.startsWith('Host plugin Task execution receipt.'))
      .length,
    1,
  );
});

test('first execution receipt inherits original clarification attribution across owner and background retries', async () => {
  for (const initialOwner of [false, true]) {
    const f = await fixture();
    const incomplete = structuredClone(f.input);
    delete incomplete.subject.closure;
    const result = initialOwner
      ? await f.owner('write', () => f.host.prepareEntrusted(incomplete))
      : await f.host.prepareEntrusted(incomplete);
    assert.equal(result.result, 'needs_clarification');
    assert.equal(
      f.messages.getByThread(f.thread.id).filter((m) => m.content.startsWith('Host plugin Task execution receipt.'))
        .length,
      0,
    );
    const complete = initialOwner
      ? await f.host.prepareEntrusted(f.input)
      : await f.owner('write', () => f.host.prepareEntrusted(f.input));
    assert.match(complete.executionRef ?? '', /^message:/);
    assert.ok(
      f.messages
        .getById(complete.executionRef.slice(8))
        .content.includes(`"mode":"${initialOwner ? 'owner_request' : 'plugin_policy'}"`),
    );
  }
});

test('first execution receipt conflict and Task drift after persistence never authorize a successful preparation', async () => {
  for (const drift of [false, true]) {
    const f = await fixture();
    const append = f.messages.appendIdempotent.bind(f.messages);
    let reached = false;
    f.messages.appendIdempotent = async (value) => {
      const result = await append(value);
      if (value.idempotencyKey.startsWith('plugin-task-execution:')) {
        reached = true;
        if (drift) f.tasks.listByKind('work')[0].entrustedWork.revision++;
        else result.message.content += 'tampered';
      }
      return result;
    };
    await assert.rejects(() => f.host.prepareEntrusted(f.input));
    assert.equal(reached, true);
    assert.equal(f.tasks.listByKind('work').length, 1, 'retain admitted Task for explicit recovery, never erase data');
  }
});

test('lost first execution response resumes the same durable Task and execution receipt', async () => {
  const f = await fixture();
  const append = f.messages.appendIdempotent.bind(f.messages);
  let lost;
  f.messages.appendIdempotent = async (value) => {
    const result = await append(value);
    if (value.idempotencyKey.startsWith('plugin-task-execution:') && !lost) {
      lost = result.message.id;
      throw Error('injected lost execution response');
    }
    return result;
  };
  await assert.rejects(() => f.host.prepareEntrusted(f.input), /injected lost/);
  const retry = await createPluginTaskHost(f.deps).prepareEntrusted(f.input);
  assert.equal(retry.executionRef, `message:${lost}`);
  assert.equal(f.tasks.listByKind('work').length, 1);
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((m) => m.content.startsWith('Host plugin Task execution receipt.'))
      .length,
    1,
  );
});

for (const caller of ['background', 'native']) {
  test(`derived Task site: ${caller} first admission creates an owned private child and reuses it`, async () => {
    const f = await fixture();
    f.thread.projectPath = '/fixture/project';
    const prepare = () => f.host.prepareEntrusted(f.input);
    const run = () =>
      caller === 'background'
        ? prepare()
        : withPluginCallContext(
            'instance',
            {
              userId: 'owner',
              threadId: f.thread.id,
              catId: 'codex',
              invocationId: 'native',
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
            prepare,
          );
    const [first, second] = await Promise.all([run(), run()]);
    assert.notEqual(first.threadId, f.source.threadId);
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.taskRef, first.taskRef);
    const child = f.threads.get(first.threadId);
    assert.equal(child.createdBy, 'owner');
    assert.equal(child.parentThreadId, f.source.threadId);
    assert.equal(child.projectPath, '/fixture/project');
    assert.deepEqual(child.participants, ['codex']);
    const next = f.messages.append({ ...structuredClone(f.source), id: undefined, content: 'Continue', timestamp: 4 });
    const continued = await f.host.prepareEntrusted({
      ...f.input,
      sourceMessageId: next.id,
      subject: { kind: 'continue', taskRef: first.taskRef, expectedRevision: first.taskRevision },
    });
    assert.equal(continued.threadId, child.id);
    assert.equal(f.threads.getChildThreads(f.thread.id).length, 1);
  });
}

test('derived Task site: new-request replay reuses an existing owner-selected Task thread', async () => {
  const f = await fixture();
  const target = f.threads.create('owner', 'Manual');
  f.threads.addParticipants(target.id, ['codex']);
  const first = await f.owner('write', () =>
    f.host.prepareEntrusted({ ...f.input, destination: { kind: 'existing_thread', threadId: target.id } }),
  );
  const replay = await f.host.prepareEntrusted(f.input);
  assert.equal(replay.threadId, target.id);
  assert.equal(replay.taskRef, first.taskRef);
  assert.equal(f.threads.getChildThreads(f.thread.id).length, 0);
});

test('derived Task site: a source thread need not already contain the execution cat', async () => {
  const f = await fixture();
  f.thread.participants = [];
  const first = await f.host.prepareEntrusted(f.input);
  assert.notEqual(first.threadId, f.thread.id);
  assert.deepEqual(f.threads.get(first.threadId).participants, ['codex']);
  assert.deepEqual(f.thread.participants, []);
});

test('derived Task site: revoked authority during owned-thread creation never admits a Task', async () => {
  const f = await fixture();
  const ensure = f.threads.ensureOwnedThread.bind(f.threads);
  let calls = 0;
  f.threads.ensureOwnedThread = async (seed) => {
    calls++;
    const child = ensure(seed);
    f.expire();
    return child;
  };
  await assert.rejects(() => f.host.prepareEntrusted(f.input));
  assert.equal(calls, 1);
  assert.equal(f.tasks.listByKind('work').length, 0);
});

test('derived Task site: missing owned-thread service does not fall back to the source thread', async () => {
  const f = await fixture();
  f.deps.readThreadStore = { get: f.threads.get.bind(f.threads) };
  await assert.rejects(() => createPluginTaskHost(f.deps).prepareEntrusted(f.input));
  assert.equal(f.tasks.listByKind('work').length, 0);
});

test('derived Task site: canonical child identity, ownership and parent cannot be substituted', async () => {
  for (const change of [
    (child) => {
      child.createdBy = 'foreign';
    },
    (child) => {
      child.parentThreadId = 'foreign-parent';
    },
    (child) => {
      child.projectPath = '/foreign/project';
    },
    (child) => {
      child.participants = [];
    },
    (child) => {
      child.deletedAt = 1;
    },
  ]) {
    const f = await fixture();
    const ensure = f.threads.ensureOwnedThread.bind(f.threads);
    f.threads.ensureOwnedThread = async (seed) => {
      const child = ensure(seed);
      change(child);
      return child;
    };
    await assert.rejects(() => f.host.prepareEntrusted(f.input));
    assert.equal(f.tasks.listByKind('work').length, 0);
  }
  const f = await fixture();
  f.threads.ensureOwnedThread = async () => f.thread;
  await assert.rejects(() => f.host.prepareEntrusted(f.input));
  assert.equal(f.tasks.listByKind('work').length, 0);
});

test('derived Task site: source recall during child creation cannot produce an admission', async () => {
  const f = await fixture();
  const ensure = f.threads.ensureOwnedThread.bind(f.threads);
  f.threads.ensureOwnedThread = async (seed) => {
    const child = ensure(seed);
    f.source.recall = { recalledAt: 1 };
    return child;
  };
  await assert.rejects(() => f.host.prepareEntrusted(f.input));
  assert.equal(f.tasks.listByKind('work').length, 0);
});
