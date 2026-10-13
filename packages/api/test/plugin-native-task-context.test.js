import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createPluginSourceFactsHost } from '../dist/domains/plugin/host-surface/plugin-source-facts-host.js';
import { captureNativeCallbackCurrentness } from '../dist/routes/plugin-native-action-currentness.js';

function fixture() {
  const binding = {
    version: 1,
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: 'task',
    taskRevision: 2,
    targetCatId: 'codex',
    threadId: 'private',
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceMessageId: 'source',
    sourceRevision: 3,
    triggerMessageId: 'trigger',
    packageDigest: 'digest',
    lifecycleRevision: 4,
    grantRevision: 5,
  };
  const record = {
    invocationId: 'inv',
    callbackToken: 'secret',
    userId: 'owner',
    catId: 'codex',
    threadId: 'private',
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: 'trigger',
    pluginTaskBinding: binding,
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'private',
      actionMethods: ['read'],
    },
  };
  const source = {
    id: 'source',
    userId: 'owner',
    threadId: 'public-source',
    catId: null,
    content: 'source body',
    source: { connector: 'neutral', meta: { businessRevision: 7 } },
    extra: { pluginMessage: { instanceId: 'instance', revision: 3 } },
  };
  const state = { live: true, reads: [], grants: ['thread.readContent', 'task.read'], source, owner: 'owner' };
  const messages = {
    async getById(id) {
      state.reads.push(id);
      return id === 'source' ? structuredClone(state.source) : null;
    },
  };
  const threads = {
    async get(id) {
      return { id, createdBy: state.owner };
    },
  };
  const fence = captureNativeCallbackCurrentness(
    record,
    'secret',
    { instanceId: 'instance', contributionId: 'private', method: 'read' },
    {
      registry: {
        async verifyLatest() {
          return state.live ? { ok: true, record } : { ok: false };
        },
      },
      threadStore: threads,
    },
  );
  const host = createPluginSourceFactsHost({
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: messages,
    threadStore: threads,
    async assertCurrent(caps) {
      if (caps.some((c) => !state.grants.includes(c))) throw Error('grant revoked');
    },
  });
  const caller = {
    ...fence.identity,
    readTaskBinding: fence.readTaskBinding,
    assertCurrent: fence.assertCurrent,
    assertInvocationCurrent: fence.assertInvocationCurrent,
  };
  const call = (input = { includeTask: true }, override = {}) =>
    withPluginCallContext('instance', { ...caller, ...override }, () => host.nativeContext.current(input));
  return { binding, record, source, state, messages, threads, fence, host, caller, call };
}

test('authenticated native Task opt-in resolves original source in another owned thread without bearer data', async () => {
  const f = fixture();
  assert.equal('pluginTaskBinding' in f.fence.identity, false);
  assert.deepEqual(await f.fence.readTaskBinding(), f.binding);
  const value = await f.call();
  assert.equal(value.originTriggerMessageId, 'trigger');
  assert.equal(value.source.id, 'source');
  assert.equal(value.source.threadId, 'public-source');
  assert.equal(value.threadId, 'private');
  assert.deepEqual(value.task, {
    taskRef: 'task:work:task',
    taskRevision: 2,
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceRevision: 3,
  });
  assert.ok(Object.isFrozen(value.task));
  assert.ok(Object.isFrozen(value.source.source.meta));
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('packageDigest'), false);
  await assert.rejects(() => withPluginCallContext('instance', f.caller, () => f.host.nativeContext.current()));
});

test('Task opt-in does not expand default sourceFacts exact-origin scope or ordinary native context', async () => {
  const f = fixture();
  const value = await f.call();
  assert.equal(value.task.taskRef, 'task:work:task');
  await assert.rejects(() =>
    withPluginCallContext('instance', f.caller, () => f.host.sourceFacts.read({ messageRef: 'message:source' })),
  );
  await assert.rejects(() => f.call({ includeTask: true }, { readTaskBinding: undefined }));
  await assert.rejects(() => f.host.nativeContext.current({ includeTask: true }));
  for (const input of [{ includeTask: false }, { includeTask: 1 }, { includeTask: true, taskRef: 'task:work:foreign' }])
    await assert.rejects(() => f.call(input));
});

for (const change of [
  'foreign-owner',
  'foreign-cat',
  'foreign-instance',
  'foreign-trigger',
  'source-revision',
  'source-recall',
  'thread-owner',
  'task-read',
  'turn-expired',
])
  test(`Task context refuses ${change} before exposing source`, async () => {
    const f = fixture();
    assert.equal((await f.call()).task.taskRef, 'task:work:task');
    let override = {};
    if (change === 'foreign-owner') override = { userId: 'foreign' };
    if (change === 'foreign-cat') override = { catId: 'foreign' };
    if (change === 'foreign-instance')
      override = { readTaskBinding: async () => ({ ...f.binding, pluginInstanceId: 'foreign' }) };
    if (change === 'foreign-trigger') override = { originTriggerMessageId: 'foreign' };
    if (change === 'source-revision') f.state.source.extra.pluginMessage.revision++;
    if (change === 'source-recall') f.state.source.recall = { recalledAt: 1 };
    if (change === 'thread-owner') f.state.owner = 'foreign';
    if (change === 'task-read') f.state.grants = ['thread.readContent'];
    if (change === 'turn-expired') f.state.live = false;
    await assert.rejects(() => f.call({ includeTask: true }, override));
  });

test('Task source and invocation changes across asynchronous reads withhold result', async () => {
  for (const change of ['source', 'invocation']) {
    const f = fixture();
    assert.equal((await f.call()).task.taskRevision, 2);
    const get = f.messages.getById.bind(f.messages);
    f.messages.getById = async (id) => {
      const old = await get(id);
      if (change === 'source') f.state.source.extra.pluginMessage.revision++;
      else f.state.live = false;
      return old;
    };
    await assert.rejects(() => f.call());
  }
});
