import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { MemoryAuthInvocationBackend } from '../src/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.ts';
import { RedisAuthInvocationBackend } from '../src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts';
import { authRecordFromRedisHash } from '../src/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.ts';

const canonicalStore = { get: async () => ({ status: 'running' }) };
const binding = () => ({
  version: 1,
  pluginInstanceId: 'instance',
  ownerUserId: 'owner',
  taskId: 'task',
  taskRevision: 2,
  targetCatId: 'codex',
  threadId: 'task-thread',
  admissionRef: 'message:admission',
  executionRef: 'message:execution',
  sourceMessageId: 'source',
  sourceRevision: 1,
  triggerMessageId: 'dispatch',
  packageDigest: 'sha512:package',
  lifecycleRevision: 3,
  grantRevision: 2,
});
const policy = () => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'private',
  actionMethods: ['work.read'],
});
const create = (registry, value = binding(), executionPolicy = policy()) =>
  registry.create(
    'owner',
    'codex',
    'task-thread',
    undefined,
    undefined,
    executionPolicy,
    'dispatch',
    'unknown',
    undefined,
    undefined,
    value,
  );
const verify = (registry, creds, method = 'verifyLatest') => registry[method](creds.invocationId, creds.callbackToken);
const input = () => ({
  invocationId: 'inv',
  callbackToken: 'token',
  userId: 'owner',
  catId: 'codex',
  threadId: 'task-thread',
  ownerAuthProvenance: 'unknown',
  originTriggerMessageId: 'dispatch',
  toolExecutionPolicy: policy(),
  pluginTaskBinding: binding(),
  createdAt: 1,
  clientMessageIds: new Set(),
});

test('private Task identity and policy are captured before storage and reads cannot mutate memory authority', async () => {
  const registry = new InvocationRegistry({
    turnExecutionStore: canonicalStore,
    assertPluginTaskCurrent: async () => {},
  });
  const value = binding(),
    p = policy();
  const creds = await create(registry, value, p);
  value.taskRevision = 900;
  p.actionMethods.push('forged');
  const record = await registry.getRecord(creds.invocationId);
  assert.equal(record.pluginTaskBinding?.taskRevision, 2);
  assert.deepEqual(record.toolExecutionPolicy.actionMethods, ['work.read']);
  assert.ok(Object.isFrozen(record.pluginTaskBinding));
  record.userId = 'intruder';
  record.pluginTaskBinding = undefined;
  const result = await verify(registry, creds);
  assert.equal(result.ok, true);
  assert.equal(result.record.userId, 'owner');
  assert.equal(result.record.pluginTaskBinding.taskRevision, 2);
});

test('missing Host Task currentness fails closed and permanently revokes the private principal', async () => {
  for (const method of ['verify', 'peek', 'verifyLatest']) {
    const registry = new InvocationRegistry();
    const creds = await create(registry);
    assert.deepEqual(await verify(registry, creds, method), { ok: false, reason: 'revoked' });
    assert.equal((await registry.getRecord(creds.invocationId)).state, 'revoked');
  }
});

test('incomplete, foreign, conflicting or forged private bindings cannot replace a live principal', async () => {
  const registry = new InvocationRegistry({
    turnExecutionStore: canonicalStore,
    assertPluginTaskCurrent: async () => {},
  });
  const valid = await create(registry);
  const bad = [
    null,
    { ...binding(), extra: true },
    { ...binding(), ownerUserId: 'foreign' },
    { ...binding(), targetCatId: 'opus' },
    { ...binding(), threadId: 'foreign' },
    { ...binding(), triggerMessageId: 'source' },
    { ...binding(), taskRevision: 0 },
    { ...binding(), executionRef: 'task:work:fake' },
    { ...binding(), admissionRef: 'message:execution' },
  ];
  for (const field of Object.keys(binding())) {
    const v = binding();
    delete v[field];
    bad.push(v);
  }
  for (const value of bad)
    await assert.rejects(() => create(registry, value), /Invalid plugin Task invocation binding/);
  assert.equal((await verify(registry, valid)).ok, true);
  for (const field of ['managedWorkBinding', 'publicInvocationBinding', 'a2aTriggerMessageId']) {
    const backend = new MemoryAuthInvocationBackend();
    await assert.rejects(() => backend.create({ ...input(), [field]: { fake: true } }));
  }
});

test('every credential verification path checks Task currentness, invalid token never does', async () => {
  let checks = 0;
  const registry = new InvocationRegistry({
    turnExecutionStore: canonicalStore,
    assertPluginTaskCurrent: async (record) => {
      checks++;
      assert.equal(record.pluginTaskBinding.executionRef, 'message:execution');
      assert.ok(Object.isFrozen(record));
    },
  });
  const creds = await create(registry);
  assert.equal((await registry.verify(creds.invocationId, 'bad')).ok, false);
  assert.equal(checks, 0);
  for (const method of ['verify', 'peek', 'verifyLatest']) {
    const before = checks;
    assert.equal((await verify(registry, creds, method)).ok, true);
    assert.ok(checks >= before + 2);
  }
});

test('Task invalidation is sticky even when the Host dependency subsequently recovers', async () => {
  let active = true;
  const registry = new InvocationRegistry({
    turnExecutionStore: canonicalStore,
    assertPluginTaskCurrent: async () => {
      if (!active) throw Error('Task closed');
    },
  });
  const creds = await create(registry);
  assert.equal((await verify(registry, creds)).ok, true);
  active = false;
  assert.equal((await verify(registry, creds)).ok, false);
  active = true;
  assert.deepEqual(await verify(registry, creds), { ok: false, reason: 'revoked' });
});

test('replacement and canonical termination during Task reads cannot authorize the old effect', async () => {
  for (const terminal of [false, true]) {
    let mutate = false;
    const canonical = { status: 'running' };
    let registry;
    registry = new InvocationRegistry({
      turnExecutionStore: { get: async () => canonical },
      assertPluginTaskCurrent: async () => {
        if (!mutate) return;
        mutate = false;
        if (terminal) Object.assign(canonical, { status: 'failed', invocationId: 'canonical', updatedAt: 1 });
        else await registry.create('owner', 'codex', 'task-thread');
      },
    });
    const creds = await create(registry);
    mutate = true;
    assert.equal((await verify(registry, creds, 'verify')).ok, false);
  }
});

test('all private identity changes across an async currentness check are rejected', async () => {
  for (const mutate of [
    (r) => {
      r.pluginTaskBinding = { ...r.pluginTaskBinding, executionRef: 'message:other' };
    },
    (r) => {
      r.originTriggerMessageId = 'different';
    },
    (r) => {
      r.ownerAuthProvenance = 'strict';
    },
    (r) => {
      r.toolExecutionPolicy = { ...r.toolExecutionPolicy, actionMethods: ['forged'] };
    },
    (r) => {
      delete r.pluginTaskBinding;
    },
  ]) {
    const backend = new MemoryAuthInvocationBackend();
    const read = backend.verifyLatest.bind(backend);
    let changed = false;
    backend.verifyLatest = async (...args) => {
      const result = await read(...args);
      if (result.ok && changed) {
        const r = { ...result.record };
        mutate(r);
        return { ok: true, record: r };
      }
      return result;
    };
    const registry = new InvocationRegistry({
      turnExecutionStore: canonicalStore,
      backend,
      assertPluginTaskCurrent: async () => {
        changed = true;
      },
    });
    const creds = await create(registry);
    assert.equal((await verify(registry, creds)).ok, false);
  }
});

test('Redis writer and fresh decoder preserve binding; partial or corrupt durable lane is refused', async () => {
  let fields;
  const redis = {
    get: async () => null,
    eval: async (_script, _count, ...args) => {
      fields = Object.fromEntries(
        Array.from({ length: (args.length - 8) / 2 }, (_, i) => [args[8 + i * 2], args[9 + i * 2]]),
      );
      return ['ok', ''];
    },
  };
  await new RedisAuthInvocationBackend(redis).create(input());
  assert.equal(fields.pluginTaskBindingVersion, '1');
  assert.deepEqual(JSON.parse(fields.pluginTaskBinding), binding());
  const restored = authRecordFromRedisHash(fields, new Set());
  assert.deepEqual(restored.pluginTaskBinding, binding());
  assert.ok(Object.isFrozen(restored.pluginTaskBinding));
  for (const mutate of [
    (f) => {
      delete f.pluginTaskBinding;
    },
    (f) => {
      delete f.pluginTaskBindingVersion;
    },
    (f) => {
      f.pluginTaskBinding = '{}';
    },
    (f) => {
      f.pluginTaskBinding = 'null';
    },
    (f) => {
      f.pluginTaskBindingVersion = '2';
    },
    (f) => {
      f.originTriggerMessageId = 'other';
    },
    (f) => {
      f.ownerAuthProvenance = 'unrecognized';
    },
    (f) => {
      f.publicInvocationBinding = '{}';
    },
  ]) {
    const corrupt = { ...fields };
    mutate(corrupt);
    assert.equal(authRecordFromRedisHash(corrupt, new Set()), null);
  }
});

test('ordinary invocations keep their original behavior and memory loss does not recreate credentials', async () => {
  const registry = new InvocationRegistry();
  const creds = await registry.create('owner', 'codex', 'ordinary');
  assert.equal((await verify(registry, creds)).ok, true);
  const lost = await verify(new InvocationRegistry(), creds);
  assert.deepEqual(lost, { ok: false, reason: 'unknown_invocation' });
});

test('native request pins Task binding presence and contents for its entire lifetime', async () => {
  const { captureNativeCallbackCurrentness } = await import('../src/routes/plugin-native-action-currentness.ts');
  for (const [present, mutate] of [
    [
      true,
      (r) => {
        delete r.pluginTaskBinding;
      },
    ],
    [
      true,
      (r) => {
        r.pluginTaskBinding = { ...binding(), executionRef: 'message:other' };
      },
    ],
    [
      false,
      (r) => {
        r.pluginTaskBinding = binding();
      },
    ],
  ]) {
    const record = { ...input(), state: 'active', expiresAt: null };
    if (!present) delete record.pluginTaskBinding;
    const initial = record.pluginTaskBinding;
    const fence = captureNativeCallbackCurrentness(
      record,
      'token',
      { instanceId: 'instance', contributionId: 'private', method: 'work.read' },
      {
        registry: { verifyLatest: async () => ({ ok: true, record }) },
        threadStore: { get: async () => ({ id: 'task-thread', createdBy: 'owner' }) },
      },
    );
    await fence.assertCurrent();
    mutate(record);
    await assert.rejects(fence.assertCurrent, /no longer current/);
    record.pluginTaskBinding = initial;
    await assert.rejects(fence.assertCurrent, /no longer current/);
    assert.equal(
      Object.hasOwn(fence.identity, 'pluginTaskBinding'),
      false,
      'Host binding is not projected to package context',
    );
  }
});

test(
  'isolated real Redis rehydrates Task principals and preserves revocation across registry replacement',
  { skip: process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1' },
  async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { assertRedisIsolationOrThrow } = await import('./helpers/redis-test-helpers.js');
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'plugin-task-invocation-binding');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `task-binding-${process.pid}:` });
    try {
      const first = new InvocationRegistry({
        turnExecutionStore: canonicalStore,
        backend: new RedisAuthInvocationBackend(redis),
        assertPluginTaskCurrent: async () => {},
      });
      const creds = await create(first);
      const restored = new InvocationRegistry({
        turnExecutionStore: canonicalStore,
        backend: new RedisAuthInvocationBackend(redis),
        assertPluginTaskCurrent: async () => {},
      });
      const result = await verify(restored, creds);
      assert.equal(result.ok, true);
      assert.deepEqual(result.record.pluginTaskBinding, binding());
      assert.equal(await redis.ttl(`auth:inv:${creds.invocationId}`), -1, 'active identity has no TTL');
      const unavailable = new InvocationRegistry({
        turnExecutionStore: canonicalStore,
        backend: new RedisAuthInvocationBackend(redis),
      });
      assert.deepEqual(await verify(unavailable, creds), { ok: false, reason: 'revoked' });
      assert.deepEqual(await verify(restored, creds), { ok: false, reason: 'revoked' });
      const corrupt = await create(first);
      await redis.hdel(`auth:inv:${corrupt.invocationId}`, 'pluginTaskBinding', 'pluginTaskBindingVersion');
      assert.equal(await redis.hget(`auth:inv:${corrupt.invocationId}`, 'principalKind'), 'plugin_task');
      for (const method of ['verify', 'peek', 'verifyLatest'])
        assert.equal((await verify(restored, corrupt, method)).ok, false);
    } finally {
      await redis.quit();
    }
  },
);

test('a Task checker cannot substitute for missing canonical TurnExecution storage', async () => {
  const registry = new InvocationRegistry({ assertPluginTaskCurrent: async () => {} });
  const creds = await create(registry);
  assert.deepEqual(await verify(registry, creds), { ok: false, reason: 'revoked' });
});

async function encodedRecord(value) {
  let fields;
  const redis = {
    get: async () => null,
    eval: async (_script, count, ...args) => {
      const pairs = args.slice(count + 4);
      fields = Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => [pairs[i * 2], pairs[i * 2 + 1]]));
      return ['ok', ''];
    },
  };
  await new RedisAuthInvocationBackend(redis).create(value);
  return fields;
}

test('R2 private principal cannot downgrade when both durable binding fields disappear', async () => {
  const fields = await encodedRecord(input());
  delete fields.pluginTaskBinding;
  delete fields.pluginTaskBindingVersion;
  assert.equal(authRecordFromRedisHash(fields, new Set()), null);
  const backend = new RedisAuthInvocationBackend({ hgetall: async () => fields });
  assert.equal((await backend.peek('inv', 'token')).ok, false);
});

test('R2 every new principal has a complete schema discriminator; legacy private records are refused', async () => {
  const ordinary = { ...input(), pluginTaskBinding: undefined };
  const publicPlugin = {
    ...ordinary,
    publicInvocationBinding: {
      version: 1,
      entryId: 'entry',
      carrier: {
        version: 1,
        admissionId: 'public-admission',
        sourceMessageId: 'dispatch',
        sourcePluginRevision: 1,
        pluginInstanceId: 'instance',
        packageDigest: 'digest',
        lifecycleRevision: 1,
        grantRevision: 0,
        contributionId: 'private',
        actionMethods: ['work.read'],
        targetCatId: 'codex',
        authorityRef: 'authority',
        authorityRevision: 'r1',
      },
    },
  };
  for (const [kind, value, payload] of [
    ['ordinary', ordinary, []],
    ['public_plugin', publicPlugin, ['publicInvocationBinding']],
    [
      'managed_work',
      { ...ordinary, managedWorkBinding: { workId: 'work', attemptId: 'attempt' } },
      ['managedWorkId', 'managedWorkAttemptId'],
    ],
    ['plugin_task', input(), ['pluginTaskBinding', 'pluginTaskBindingVersion']],
  ]) {
    const fields = await encodedRecord(value);
    assert.equal(fields.recordSchemaVersion, '1');
    assert.equal(fields.principalKind, kind);
    assert.ok(authRecordFromRedisHash(fields, new Set()));
    for (const key of ['recordSchemaVersion', 'principalKind']) {
      const damaged = { ...fields };
      delete damaged[key];
      assert.equal(authRecordFromRedisHash(damaged, new Set()), null);
    }
    assert.equal(authRecordFromRedisHash({ ...fields, recordSchemaVersion: '2' }, new Set()), null);
    assert.equal(authRecordFromRedisHash({ ...fields, principalKind: 'unrecognized' }, new Set()), null);
    if (payload.length) {
      const damaged = { ...fields };
      for (const key of payload) delete damaged[key];
      assert.equal(authRecordFromRedisHash(damaged, new Set()), null);
      assert.equal(authRecordFromRedisHash({ ...fields, principalKind: 'ordinary' }, new Set()), null);
    }
    const legacy = { ...fields };
    delete legacy.recordSchemaVersion;
    delete legacy.principalKind;
    assert.equal(authRecordFromRedisHash(legacy, new Set()) !== null, kind !== 'plugin_task');
  }
});

test('R2 Task checker receives only deeply immutable authority coordinates, never bearer or telemetry', async () => {
  let observed;
  const registry = new InvocationRegistry({
    turnExecutionStore: canonicalStore,
    assertPluginTaskCurrent: async (value) => {
      observed = value;
    },
  });
  const creds = await create(registry);
  assert.equal((await verify(registry, creds)).ok, true);
  assert.deepEqual(
    Object.keys(observed).sort(),
    [
      'invocationId',
      'userId',
      'catId',
      'threadId',
      'ownerAuthProvenance',
      'originTriggerMessageId',
      'pluginTaskBinding',
      'toolExecutionPolicy',
    ].sort(),
  );
  assert.ok(Object.isFrozen(observed));
  assert.ok(Object.isFrozen(observed.pluginTaskBinding));
  assert.ok(Object.isFrozen(observed.toolExecutionPolicy.actionMethods));
  assert.throws(() => {
    observed.pluginTaskBinding.taskRevision = 999;
  }, TypeError);
  assert.equal(JSON.stringify(observed).includes(creds.callbackToken), false);
  assert.equal((await verify(registry, creds)).ok, true);
});
