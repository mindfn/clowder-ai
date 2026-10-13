import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { buildQueueEntry } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import * as authorityModule from '../src/domains/plugin/host-surface/plugin-task-currentness.ts';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/plugin-task-host.ts';

async function fixture(continued = false) {
  const messages = new MessageStore(),
    tasks = new TaskStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'Dispatch');
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
  const host = createPluginTaskHost({
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.admitEntrusted'],
    taskStore: tasks,
    readThreadStore: threads,
    admission: { messageStore: messages, isCatAvailable: () => true, assertCurrent: async () => {} },
  });
  let admission = await host.prepareEntrusted({
    sourceMessageId: source.id,
    targetCatId: 'codex',
    destination: { kind: 'derived_from_source' },
    subject: {
      kind: 'new',
      title: 'Report',
      intendedOutcome: 'A report',
      closure: { condition: 'Accepted', expectedSignal: 'yes' },
    },
  });
  let currentSource = source;
  if (continued) {
    currentSource = messages.append({ ...structuredClone(source), id: undefined, content: 'Continue report' });
    admission = await host.prepareEntrusted({
      sourceMessageId: currentSource.id,
      targetCatId: 'codex',
      destination: { kind: 'derived_from_source' },
      subject: { kind: 'continue', taskRef: admission.taskRef, expectedRevision: admission.taskRevision },
    });
  }
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
  const deps = {
    ownerUserId: 'owner',
    taskStore: tasks,
    messageStore: messages,
    threadStore: threads,
    inventory: { snapshot: async () => state },
    isCatAvailable: () => true,
  };
  assert.equal(typeof authorityModule.createPluginTaskDispatchAuthority, 'function');
  const authority = authorityModule.createPluginTaskDispatchAuthority(deps, 'instance');
  return {
    messages,
    tasks,
    threads,
    thread,
    source: currentSource,
    state,
    deps,
    admission,
    authority,
    selection: {
      taskRef: admission.taskRef,
      taskRevision: admission.taskRevision,
      executionRef: admission.executionRef,
    },
  };
}
for (const continued of [false, true])
  test(`dispatch derives ${continued ? 'continuation' : 'first'} authority before any trigger exists`, async () => {
    const f = await fixture(continued),
      before = f.messages.getByThread(f.thread.id).length;
    const b = await f.authority.read(f.selection);
    assert.equal(b.sourceMessageId, f.source.id);
    assert.equal(b.ownerUserId, 'owner');
    assert.equal(b.pluginInstanceId, 'instance');
    assert.equal(b.executionRef, f.admission.executionRef);
    assert.equal(b.taskId, f.admission.taskRef.slice(10));
    assert.equal(b.triggerMessageId, undefined);
    assert.equal(b.packageDigest, 'digest');
    assert.equal(b.lifecycleRevision, 3);
    assert.equal(f.messages.getByThread(f.thread.id).length, before);
  });
for (const mutation of ['closed', 'source', 'grant', 'forged', 'index', 'extra'])
  test(`dispatch preflight rejects ${mutation}`, async () => {
    const f = await fixture();
    if (mutation === 'closed') f.tasks.get(f.selection.taskRef.slice(10)).entrustedWork.closure.state = 'completed';
    if (mutation === 'source') f.source.extra.pluginMessage.revision++;
    if (mutation === 'grant') f.state.grants[0].effectiveGrants = [];
    if (mutation === 'forged') f.messages.getById(f.selection.executionRef.slice(8)).content += ' ';
    if (mutation === 'index') {
      const get = f.messages.getByIdempotencyKey.bind(f.messages);
      f.messages.getByIdempotencyKey = (...args) =>
        args[2].startsWith('plugin-task-execution:') ? null : get(...args);
    }
    if (mutation === 'extra') f.selection.ownerUserId = 'owner';
    await assert.rejects(f.authority.read(f.selection));
  });

async function producerFixture() {
  const f = await fixture();
  const queue = new InvocationQueue(),
    resumes = [];
  const services = {
    messageStore: f.messages,
    queue,
    readAuthority: f.authority.read,
    async resume(threadId, userId) {
      resumes.push([threadId, userId]);
    },
  };
  const deps = {
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.admitEntrusted'],
    taskStore: f.tasks,
    readThreadStore: f.threads,
    admission: { messageStore: f.messages, isCatAvailable: () => true, assertCurrent: async () => {} },
    dispatch: services,
  };
  const host = createPluginTaskHost(deps);
  assert.equal(typeof host.dispatchEntrusted, 'function');
  return { ...f, queue, resumes, services, deps, host };
}
async function attachStaleConsumer(f, replacementRace = false) {
  const [{ QueueProcessor }, { InvocationTracker }, { InvocationRecordStore }, { createTaskQueueRoute }] =
    await Promise.all([
      import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js'),
      import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'),
      import('../src/domains/plugin/carrier/task-queue-route.ts'),
    ]);
  const effects = { parents: 0, providers: 0, completions: 0, hooks: 0, visible: [], errors: [], updates: [] };
  const records = new InvocationRecordStore();
  const create = records.create.bind(records);
  records.create = (...args) => {
    effects.parents++;
    return create(...args);
  };
  const authority = authorityModule.createPluginTaskQueueAuthority({
    ownerUserId: 'owner',
    taskStore: f.tasks,
    messageStore: f.messages,
    threadStore: f.threads,
    inventory: { snapshot: async () => f.state },
    isCatAvailable: () => true,
  });
  const route = createTaskQueueRoute(
    f.queue,
    () => authority,
    () => ({
      async resolveTaskInvocationPolicy() {
        throw Error('must not prepare stale Task');
      },
    }),
    {
      async prepare() {
        throw Error('must not launch stale Task');
      },
    },
  );
  const processor = new QueueProcessor({
    queue: f.queue,
    messageStore: f.messages,
    invocationRecordStore: records,
    invocationTracker: new InvocationTracker(),
    taskInvocationRoute: route,
    router: {
      async *routeExecution() {
        effects.providers++;
        throw Error('must not run stale Task');
      },
    },
    socketManager: {
      broadcastAgentMessage(m) {
        effects.visible.push(m);
      },
      broadcastToRoom() {},
      emitToUser(_id, event, payload) {
        if (event === 'queue_updated') effects.updates.push(payload);
      },
    },
    log: {
      info() {},
      warn() {},
      error(...args) {
        effects.errors.push(args);
      },
    },
  });
  processor.onInvocationComplete = async () => {
    effects.completions++;
  };
  const execute = processor.executeEntry.bind(processor);
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });
  processor.executeEntry = async (...args) => {
    const result = await execute(...args);
    completed(result);
    return result;
  };
  if (replacementRace) {
    const remove = f.queue.removeEntrySnapshotIfUnchanged.bind(f.queue);
    f.queue.removeEntrySnapshotIfUnchanged = (expected) => {
      effects.replacement = { ...structuredClone(expected), content: 'concurrent replacement', priority: 'high' };
      assert.equal(f.queue.restoreEntrySnapshotIfUnchanged(expected, effects.replacement), true);
      return remove(expected);
    };
  }
  const entry = f.queue.list(f.thread.id, 'owner')[0];
  if (entry)
    processor.registerEntryCompleteHook(entry.id, () => {
      effects.hooks++;
    });
  f.services.resume = async (threadId, userId) => {
    f.resumes.push([threadId, userId]);
    await processor.resumeAfterStartup(threadId, userId);
    let timer;
    try {
      await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('consumer stalled')), 2000);
        }),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      clearTimeout(timer);
    }
  };
  return { effects, processor };
}

test('producer persists one protected trigger/custody and restores only the Task lane on concurrent replay', async () => {
  const f = await producerFixture();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.host.dispatchEntrusted(f.selection)));
  assert.equal(new Set(results.map((r) => r.messageRef)).size, 1);
  assert.equal(new Set(results.map((r) => r.entryId)).size, 1);
  const trigger = f.messages.getById(results[0].messageRef.slice(8));
  assert.equal(trigger.queueCustody.sourceCategory, 'plugin_task');
  assert.equal(trigger.queueCustody.ownerAuthProvenance, 'unknown');
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 1);
  assert.equal(f.queue.list(f.thread.id, 'owner')[0].sourceCategory, 'plugin_task');
  assert.equal(trigger.content.includes('Make report'), false);
  assert.ok(f.resumes.length > 0);
});
test('producer response-loss retry restores existing durable custody without another trigger', async () => {
  const f = await producerFixture();
  const init = f.messages.initializeQueueCustody.bind(f.messages);
  let lost = false;
  f.messages.initializeQueueCustody = (...args) => {
    const result = init(...args);
    if (!lost) {
      lost = true;
      throw Error('lost custody response');
    }
    return result;
  };
  await assert.rejects(f.host.dispatchEntrusted(f.selection), /lost custody/);
  const result = await f.host.dispatchEntrusted(f.selection);
  assert.equal(result.status, 'queued');
  assert.equal(
    f.messages
      .getByThread(f.thread.id, undefined, undefined, { includeQueuedUserMessages: true })
      .filter((m) => m.queueCustody).length,
    1,
  );
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 1);
});
test('producer rejects stale Task before writing any trigger', async () => {
  const f = await producerFixture(),
    before = f.messages.getByThread(f.thread.id).length;
  f.tasks.get(f.selection.taskRef.slice(10)).entrustedWork.closure.state = 'completed';
  await assert.rejects(f.host.dispatchEntrusted(f.selection));
  assert.equal(f.messages.getByThread(f.thread.id).length, before);
  assert.deepEqual(f.resumes, []);
});
test('producer rejects native origin mismatch even with a valid prepared execution receipt', async () => {
  const f = await producerFixture(),
    before = f.messages.getByThread(f.thread.id).length;
  await assert.rejects(
    withPluginCallContext(
      'instance',
      {
        invocationId: 'native',
        userId: 'owner',
        catId: 'codex',
        threadId: f.thread.id,
        originTriggerMessageId: 'wrong',
        toolExecutionPolicy: {
          mode: 'plugin_native',
          pluginInstanceId: 'instance',
          contributionId: 'private',
          actionMethods: ['work'],
        },
        assertCurrent: async () => {},
      },
      () => f.host.dispatchEntrusted(f.selection),
    ),
  );
  assert.equal(f.messages.getByThread(f.thread.id).length, before);
});

test('producer replays a started execution without restoring or resuming another child', async () => {
  const f = await producerFixture();
  const first = await f.host.dispatchEntrusted(f.selection);
  const message = f.messages.getById(first.messageRef.slice(8));
  const { createPluginTaskQueueAuthority } = authorityModule;
  const authority = createPluginTaskQueueAuthority({
    ...f.deps,
    ownerUserId: 'owner',
    taskStore: f.tasks,
    messageStore: f.messages,
    threadStore: f.threads,
    inventory: { snapshot: async () => f.state },
    isCatAvailable: () => true,
  });
  const selected = {
    messageId: message.id,
    entryId: first.entryId,
    userId: 'owner',
    threadId: f.thread.id,
    targetCatId: 'codex',
  };
  const binding = await authority.read(selected);
  await authority.bindChild({ ...selected, binding, invocationId: 'actual-child' });
  const count = f.resumes.length;
  const second = await f.host.dispatchEntrusted(f.selection);
  assert.equal(second.entryId, first.entryId);
  assert.equal(second.status, 'processing');
  assert.equal(f.resumes.length, count);
});
for (const window of ['authority', 'storage'])
  for (const status of ['processing', 'terminal'])
    test(`producer does not resurrect custody advanced to ${status} during the final ${window} await`, async () => {
      const f = await producerFixture();
      const authority = authorityModule.createPluginTaskQueueAuthority({
        ownerUserId: 'owner',
        taskStore: f.tasks,
        messageStore: f.messages,
        threadStore: f.threads,
        inventory: { snapshot: async () => f.state },
        isCatAvailable: () => true,
      });
      let custodyReads = 0;
      let advanced = false;
      let restores = 0;
      const restore = f.queue.restoreDurableEntry.bind(f.queue);
      f.queue.restoreDurableEntry = (entry) => {
        restores++;
        return restore(entry);
      };
      const advance = async (trigger) => {
        const entry = buildQueueEntry([trigger], trigger.queueCustody.entryId);
        const selected = {
          messageId: trigger.id,
          entryId: entry.id,
          userId: 'owner',
          threadId: f.thread.id,
          targetCatId: 'codex',
        };
        const binding = await authority.read(selected);
        await authority.bindChild({ ...selected, binding, invocationId: 'racing-child' });
        if (status === 'terminal') {
          const current = f.messages.getById(trigger.id).queueCustody;
          const next = structuredClone(current);
          next.revision++;
          next.status = 'terminal';
          delete next.processingStartedAt;
          delete next.awakenedInvocationIdByCatId;
          delete next.awakenedAtByCatId;
          next.pendingTargetCats = [];
          next.handledByCatIds = ['codex'];
          next.updatedAt = Math.max(Date.now(), current.updatedAt);
          next.targetAttempts = next.targetAttempts.map((attempt) => ({
            ...attempt,
            state: 'handled',
            updatedAt: next.updatedAt,
          }));
          const settled = await f.messages.transitionQueueCustody(trigger.id, {
            expectedRevision: current.revision,
            next,
            deliveredAt: next.updatedAt,
          });
          assert.equal(settled.kind, 'updated');
        }
        assert.equal(f.messages.getById(trigger.id).queueCustody.status, status);
        advanced = true;
      };
      let finalReadArmed = false;
      let canonicalAfterAdvance;
      let consumer;
      f.services.readAuthority = async (input) => {
        const result = await f.authority.read(input);
        const trigger = f.messages
          .getByThread(f.thread.id, undefined, undefined, { includeQueuedUserMessages: true })
          .find((m) => m.queueCustody);
        // The post-initialize check reads authority twice; the third is the final restore fence.
        if (trigger && ++custodyReads === 3) {
          if (window === 'authority') await advance(trigger);
          else finalReadArmed = true;
        }
        return result;
      };
      if (window === 'storage') {
        const delegate = Object.fromEntries(
          ['getByIdempotencyKey', 'appendIdempotent', 'prepareQueueAdmission', 'initializeQueueCustody'].map((name) => [
            name,
            f.messages[name].bind(f.messages),
          ]),
        );
        consumer = await attachStaleConsumer(f);
        f.services.messageStore = {
          ...delegate,
          async getById(id) {
            const snapshot = structuredClone(f.messages.getById(id));
            if (finalReadArmed) {
              finalReadArmed = false;
              await advance(snapshot);
              canonicalAfterAdvance = structuredClone(f.messages.getById(id));
            }
            return snapshot;
          },
        };
      }
      const result = await f.host.dispatchEntrusted(f.selection);
      assert.equal(advanced, true);
      assert.equal(result.status, status);
      if (window === 'authority') {
        assert.equal(restores, 0);
        assert.deepEqual(f.resumes, []);
      } else {
        assert.equal(restores, 1); // A process-local projection is allowed; it is never execution authority.
        assert.equal(f.resumes.length, 1);
        assert.equal(consumer.effects.parents, 0);
        assert.equal(consumer.effects.providers, 0);
        assert.equal(consumer.effects.completions, 0);
        assert.deepEqual(consumer.effects.visible, []);
        assert.deepEqual(consumer.effects.errors, []);
        assert.deepEqual(f.messages.getById(result.messageRef.slice(8)), canonicalAfterAdvance);
      }
      assert.deepEqual(f.queue.list(f.thread.id, 'owner'), []);
    });
for (const kind of [
  'processing',
  'terminal',
  'canceled',
  'replacement',
  'revoked',
  'steer-requested',
  'steer-replacement',
  'source-revoked',
])
  test(`consumer prunes only stale Task projection: ${kind}`, async () => {
    const f = await producerFixture();
    const first = await f.host.dispatchEntrusted(f.selection);
    const triggerId = first.messageRef.slice(8);
    const authority = authorityModule.createPluginTaskQueueAuthority({
      ownerUserId: 'owner',
      taskStore: f.tasks,
      messageStore: f.messages,
      threadStore: f.threads,
      inventory: { snapshot: async () => f.state },
      isCatAvailable: () => true,
    });
    const selected = {
      messageId: triggerId,
      entryId: first.entryId,
      userId: 'owner',
      threadId: f.thread.id,
      targetCatId: 'codex',
    };
    if (kind === 'revoked') f.state.grants[0].effectiveGrants = [];
    else if (kind === 'source-revoked') f.messages.markCanceled(f.source.id);
    else if (kind === 'canceled') f.messages.markCanceled(triggerId);
    else if (kind.startsWith('steer-')) {
      const current = f.messages.getById(triggerId).queueCustody;
      const next = { ...structuredClone(current), revision: current.revision + 1, steerRequestedByCatIds: ['codex'] };
      assert.equal(
        f.messages.transitionQueueCustody(triggerId, { expectedRevision: current.revision, next }).kind,
        'updated',
      );
      assert.equal(f.messages.getById(triggerId).queueCustody.status, 'queued');
    } else {
      await authority.bindChild({ ...selected, binding: await authority.read(selected), invocationId: 'other-child' });
      if (kind === 'terminal') {
        const current = f.messages.getById(triggerId).queueCustody;
        const next = {
          ...structuredClone(current),
          revision: current.revision + 1,
          status: 'terminal',
          pendingTargetCats: [],
          handledByCatIds: ['codex'],
        };
        delete next.processingStartedAt;
        delete next.awakenedInvocationIdByCatId;
        delete next.awakenedAtByCatId;
        next.targetAttempts = next.targetAttempts.map((a) => ({ ...a, state: 'handled' }));
        assert.equal(
          f.messages.transitionQueueCustody(triggerId, {
            expectedRevision: current.revision,
            next,
            deliveredAt: Date.now(),
          }).kind,
          'updated',
        );
      }
    }
    const before = structuredClone(f.messages.getById(triggerId));
    const { effects } = await attachStaleConsumer(f, kind.endsWith('replacement'));
    await f.services.resume(f.thread.id, 'owner');
    assert.equal(effects.parents, 0);
    assert.equal(effects.providers, 0);
    assert.equal(effects.hooks, 0);
    assert.deepEqual(f.messages.getById(triggerId), before);
    const local = f.queue.getEntrySnapshot(f.thread.id, 'owner', first.entryId);
    if (kind === 'revoked' || kind === 'source-revoked') assert.equal(local.status, 'queued');
    else {
      assert.equal(effects.completions, 0);
      assert.deepEqual(effects.visible, []);
      assert.deepEqual(effects.errors, []);
      assert.equal(
        effects.updates.some((u) => u.action === 'completed'),
        false,
      );
      if (kind.endsWith('replacement')) assert.deepEqual(local, effects.replacement);
      else assert.equal(local, null);
    }
  });

test('producer post-write revocation retains durable evidence and does not restore Queue', async () => {
  const f = await producerFixture(),
    append = f.messages.appendIdempotent.bind(f.messages);
  f.messages.appendIdempotent = async (input) => {
    const result = await append(input);
    f.source.extra.pluginMessage.revision++;
    return result;
  };
  await assert.rejects(f.host.dispatchEntrusted(f.selection));
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
  assert.deepEqual(f.resumes, []);
  assert.ok(
    f.messages.getByThread(f.thread.id).some((m) => m.content.startsWith('Host plugin Task execution trigger.')),
  );
});
test('producer native exact-origin lane accepts the current receipt', async () => {
  const f = await producerFixture();
  const result = await withPluginCallContext(
    'instance',
    {
      invocationId: 'native',
      userId: 'owner',
      catId: 'codex',
      threadId: f.thread.id,
      originTriggerMessageId: f.source.id,
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'instance',
        contributionId: 'private',
        actionMethods: ['work'],
      },
      assertCurrent: async () => {},
    },
    () => f.host.dispatchEntrusted(f.selection),
  );
  assert.equal(result.status, 'queued');
});
test('producer owner read context cannot dispatch, owner write can', async () => {
  const { withPluginOwnerRequest, withPluginOwnerWebhook } = await import(
    '../src/domains/plugin/carrier/plugin-owner-request-context.ts'
  );
  const f = await producerFixture();
  const run = (operation) =>
    withPluginOwnerRequest(
      {
        pluginId: 'neutral',
        contributionId: 'owner',
        userId: 'owner',
        operation,
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          'neutral',
          'owner',
          'instance',
          false,
          () => {},
          () => f.host.dispatchEntrusted(f.selection),
        ),
    );
  await assert.rejects(run('read'));
  assert.deepEqual(f.resumes, []);
  assert.equal((await run('write')).status, 'queued');
});
