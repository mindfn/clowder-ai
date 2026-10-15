import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { EntrustedWorkOwnerReadService } from '../src/domains/growing/EntrustedWorkOwnerReadService.ts';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/plugin-task-host.ts';

async function fixture() {
  const tasks = new TaskStore(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = await threads.create('owner', 'Work');
  threads.addParticipants(thread.id, ['codex']);
  const source = messages.append({
    userId: 'owner',
    threadId: thread.id,
    catId: null,
    content: 'Produce the report.',
    timestamp: 1,
    source: { connector: 'plugin', label: 'Plugin', icon: 'message' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  const changes = [];
  const deps = {
    pluginId: 'fixture',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.read', 'task.write', 'task.admitEntrusted'],
    taskStore: tasks,
    threadStore: threads,
    readThreadStore: threads,
    assertCurrent: async () => {},
    onTaskDataChanged: (task) => changes.push(task.id),
    admission: { messageStore: messages, isCatAvailable: (id) => id === 'codex', assertCurrent: async () => {} },
    dispatch: new Proxy(
      {},
      {
        get() {
          throw Error('data must not access dispatch');
        },
      },
    ),
  };
  const host = createPluginTaskHost(deps);
  const data = {
    sourceMessageId: source.id,
    intendedOutcome: 'A report',
    closure: { condition: 'Accepted report', expectedSignal: 'accepted' },
    time: { businessDeadline: { value: 1900000000000, sourceRef: `message:${source.id}` } },
  };
  const input = {
    threadId: thread.id,
    title: 'Report',
    kind: 'work',
    subjectKey: 'fixture:work:1',
    ownerCatId: 'codex',
    entrustedWork: data,
  };
  const ownerRead = new EntrustedWorkOwnerReadService({
    tasks,
    producerCatalog: { listCurrentReceipts: async () => [] },
  });
  return { tasks, messages, threads, thread, source, changes, deps, host, input, ownerRead };
}

test('same Task has a Schedule deadline, changes it, then closes without any execution carrier', async () => {
  const f = await fixture();
  const task = await f.host.upsertBySubject(f.input);
  const active = await f.ownerRead.listForOwner('owner');
  assert.equal(active.length, 1, 'original Schedule must include the created task');
  assert.equal(active[0].timeRefs.find((t) => t.role === 'business_deadline').value, 1900000000000);
  assert.equal((await f.host.upsertBySubject(f.input)).id, task.id);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  const read = await f.host.get(task.id);
  assert.equal(read.entrustedWork.time.businessDeadline.value, 1900000000000);
  const updated = await f.host.updateIfThreadId(task.id, f.thread.id, {
    entrustedWork: {
      expectedRevision: read.entrustedWork.revision,
      time: { businessDeadline: { value: 1900000100000, sourceRef: `message:${f.source.id}` } },
    },
  });
  assert.equal(
    (await f.ownerRead.listForOwner('owner'))[0].timeRefs.find((t) => t.role === 'business_deadline').value,
    1900000100000,
  );
  await assert.rejects(
    f.host.update(task.id, { entrustedWork: { expectedRevision: 1, time: { businessDeadline: null } } }),
    /revision/i,
  );
  await assert.rejects(f.host.update(task.id, { status: 'done' }), /typed|entrusted/i);
  const closed = await f.host.updateIfThreadId(task.id, f.thread.id, {
    entrustedWork: {
      expectedRevision: updated.entrustedWork.revision,
      closure: { ...f.input.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['service:accepted:1'] },
    },
  });
  assert.equal(closed.id, task.id);
  assert.equal(closed.status, 'done');
  assert.equal((await f.ownerRead.listForOwner('owner')).length, 0);
  assert.equal((await f.ownerRead.listForOwner('owner', 'completed')).length, 1);
  assert.deepEqual(f.changes, [task.id, task.id, task.id]);
  assert.equal(f.messages.getRecent(100, 'owner').length, 1, 'no execution/admission carrier message');
});

test('foreign source, absent grant, foreign Task and conflicting bare Task cannot be adopted', async () => {
  const f = await fixture();
  await assert.rejects(
    createPluginTaskHost({ ...f.deps, effectiveGrants: ['task.write'] }).upsertBySubject(f.input),
    /task.admitEntrusted/,
  );
  await assert.rejects(
    createPluginTaskHost({ ...f.deps, pluginInstanceId: 'other' }).upsertBySubject(f.input),
    /source|installation/i,
  );
  const task = await f.host.upsertBySubject(f.input);
  await assert.rejects(
    createPluginTaskHost({ ...f.deps, ownerUserId: 'other' }).update(task.id, {
      entrustedWork: { expectedRevision: 1, time: { businessDeadline: null } },
    }),
    /owner|installation/i,
  );
  const bare = f.tasks.create({
    threadId: f.thread.id,
    title: 'Bare',
    why: '',
    createdBy: 'user',
    userId: 'owner',
    ownerCatId: 'codex',
    subjectKey: 'bare',
  });
  await assert.rejects(f.host.upsertBySubject({ ...f.input, subjectKey: 'bare' }), /conflict|contract|entrusted/i);
  assert.equal(f.tasks.get(bare.id).entrustedWork, undefined);
});

test('ordinary native calls need no execution policy; read-only and expired calls cannot write', async () => {
  const { withPluginCallContext } = await import('../src/domains/plugin/carrier/plugin-call-context.ts');
  const { withPluginOwnerRequest, withPluginOwnerWebhook } = await import(
    '../src/domains/plugin/carrier/plugin-owner-request-context.ts'
  );
  const f = await fixture();
  const native = {
    userId: 'owner',
    catId: 'codex',
    threadId: f.thread.id,
    invocationId: 'ordinary',
    originTriggerMessageId: f.source.id,
    assertCurrent: async () => {},
  };
  const task = await withPluginCallContext('instance', native, () => f.host.upsertBySubject(f.input));
  assert.equal(task.entrustedWork.revision, 1);
  assert.equal(task.entrustedWork.execution, undefined);
  await assert.rejects(
    withPluginCallContext('instance', { ...native, catId: 'other' }, () =>
      f.host.update(task.id, { entrustedWork: { expectedRevision: 1, time: { businessDeadline: null } } }),
    ),
    /invocation/,
  );
  await assert.rejects(
    withPluginOwnerRequest(
      {
        pluginId: 'fixture',
        contributionId: 'http',
        userId: 'owner',
        operation: 'read',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          'fixture',
          'http',
          'instance',
          false,
          () => {},
          () => f.host.upsertBySubject(f.input),
        ),
    ),
    /write/,
  );
  await assert.rejects(
    createPluginTaskHost({
      ...f.deps,
      assertCurrent: () => {
        throw Error('activation expired');
      },
    }).update(task.id, { entrustedWork: { expectedRevision: 1, time: { businessDeadline: null } } }),
    /expired/,
  );
  await assert.rejects(
    createPluginTaskHost({ ...f.deps, pluginInstanceId: 'other' }).update(task.id, {
      entrustedWork: { expectedRevision: 1, time: { businessDeadline: null } },
    }),
    /installation/,
  );
  assert.equal(f.tasks.get(task.id).entrustedWork.revision, 1);
});

test('changed or recalled source cannot create data and mutation cannot cite an unrelated source', async () => {
  const f = await fixture();
  const task = await f.host.upsertBySubject(f.input);
  await assert.rejects(
    f.host.update(task.id, {
      entrustedWork: {
        expectedRevision: 1,
        time: { businessDeadline: { value: 1900000000001, sourceRef: 'message:unrelated' } },
      },
    }),
    /source/,
  );
  let reads = 0;
  const host = createPluginTaskHost({
    ...f.deps,
    admission: {
      ...f.deps.admission,
      messageStore: { getById: async () => ({ ...f.source, content: ++reads === 1 ? 'first' : 'changed' }) },
    },
  });
  await assert.rejects(host.upsertBySubject({ ...f.input, subjectKey: 'changed' }), /changed/);
  const recalled = createPluginTaskHost({
    ...f.deps,
    admission: { ...f.deps.admission, messageStore: { getById: async () => ({ ...f.source, recall: {} }) } },
  });
  await assert.rejects(recalled.upsertBySubject({ ...f.input, subjectKey: 'recalled' }), /source/);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  assert.equal(f.changes.length, 1);
});

test('a newer source revision cannot replay the original Task admission', async () => {
  const f = await fixture();
  let source = structuredClone(f.source);
  const host = createPluginTaskHost({
    ...f.deps,
    admission: { ...f.deps.admission, messageStore: { getById: async () => source } },
  });
  const original = structuredClone(await host.upsertBySubject(f.input));
  assert.equal((await host.upsertBySubject(f.input)).id, original.id);
  source = {
    ...source,
    content: 'Produce the revised report.',
    extra: {
      ...source.extra,
      pluginMessage: { ...source.extra.pluginMessage, revision: 2 },
    },
  };
  await assert.rejects(
    host.upsertBySubject({
      ...f.input,
      title: 'Revised report',
      entrustedWork: {
        ...f.input.entrustedWork,
        time: { businessDeadline: { value: 1900000200000, sourceRef: `message:${source.id}` } },
      },
    }),
    /conflict|idempotency/i,
  );
  assert.deepEqual(f.tasks.get(original.id), original);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  assert.deepEqual(f.changes, [original.id]);
  // An explicit revision-CAS edit is distinct from replaying admission.
  const updated = await host.update(original.id, {
    entrustedWork: {
      expectedRevision: original.entrustedWork.revision,
      time: { businessDeadline: { value: 1900000200000, sourceRef: `message:${source.id}` } },
    },
  });
  assert.equal(updated.id, original.id);
  assert.equal(updated.entrustedWork.time.businessDeadline.value, 1900000200000);
});
