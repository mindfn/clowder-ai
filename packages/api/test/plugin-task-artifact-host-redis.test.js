import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import { createPluginTaskArtifactHost } from '../src/domains/plugin/host-surface/plugin-task-artifact-host.ts';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const clients = [];
after(async () => {
  await Promise.all(clients.map((c) => c.quit()));
});
async function fixture() {
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `task-artifact-${randomUUID()}:` });
  clients.push(redis);
  const messages = new RedisMessageStore(redis),
    tasks = new RedisTaskStore(redis);
  const { task } = await tasks.admitEntrustedWork({
    subjectKey: 'entrusted:proof',
    task: {
      userId: 'owner',
      threadId: 'private',
      ownerCatId: 'codex',
      createdBy: 'user',
      title: 'Report',
      why: 'Report',
    },
    entrustedWork: {
      revision: 1,
      admission: {
        basis: 'authorized_source',
        sourceRefs: ['message:source'],
        authorityRef: 'message:admission',
        idempotencyKey: 'admission',
        receiptRef: 'receipt:admission',
        admittedAt: 1,
      },
      intendedOutcome: 'Report',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'accepted', expectedSignal: 'accepted', evidenceRefs: [] },
    },
  });
  const binding = {
    version: 2,
    executionAuthorityRevision: 1,
    executionReceiptDigest: 'a'.repeat(64),
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: task.id,
    taskRevision: 1,
    targetCatId: 'codex',
    threadId: 'private',
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceMessageId: 'source',
    sourceRevision: 1,
    triggerMessageId: 'trigger',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
  };
  let live = true,
    grants = ['task.read', 'task.write', 'thread.readContent', 'thread.write'];
  // Unit boundary fixture: callback currentness is injected here; separate v2 integration uses actual Registry/Queue.
  const check = async () => {
    assert.ok(live, 'revoked');
  };
  const native = {
    userId: 'owner',
    threadId: 'private',
    catId: 'codex',
    invocationId: 'child',
    originTriggerMessageId: 'trigger',
    ownerAuthProvenance: 'unknown',
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'private',
      actionMethods: ['artifact'],
    },
    assertCurrent: check,
    assertInvocationCurrent: check,
    readTaskBinding: async () => {
      await check();
      return structuredClone(binding);
    },
  };
  const taskArtifactDirectory = await mkdtemp(join(tmpdir(), 'task-artifact-'));
  const deps = {
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: messages,
    taskStore: tasks,
    taskArtifactDirectory,
    assertCurrent: async (caps) => {
      await check();
      assert.ok(
        caps.every((c) => grants.includes(c)),
        'missing capability',
      );
    },
  };
  const host = createPluginTaskArtifactHost(deps);
  const run = (fn, ctx = native) => withPluginCallContext('instance', ctx, fn);
  return {
    host,
    redis,
    deps,
    run,
    native,
    binding,
    messages,
    tasks,
    task,
    taskArtifactDirectory,
    revoke: () => {
      live = false;
    },
    grants: (v) => {
      grants = v;
    },
  };
}
const text = { text: 'Redis durable 猫 artifact', mediaType: 'text/plain' };
describe('Task artifact actual Redis publication', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  before(() => assertRedisIsolationOrThrow(process.env.REDIS_URL, 'task-artifact-publication'));
  test('fresh stores recover publication/ref/seal after attach and retain TTL zero', async () => {
    const f = await fixture(),
      a = await f.run(() => f.host.publishText(text));
    const restored = createPluginTaskArtifactHost({
      ...f.deps,
      messageStore: new RedisMessageStore(f.redis),
      taskStore: new RedisTaskStore(f.redis),
    });
    assert.deepEqual(await f.run(() => restored.publishText(text)), a);
    assert.equal(
      (await f.run(() => restored.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef }))).text,
      text.text,
    );
    assert.equal((await f.tasks.get(f.task.id)).entrustedWork.revision, 2);
    assert.equal(await f.redis.ttl(`msg:${a.publicationRef.slice(8)}`), -1);
  });
  for (const lost of ['publication', 'attach'])
    test(`durable ${lost} with lost response replays exactly once`, async () => {
      const f = await fixture();
      const obj = lost === 'publication' ? f.messages : f.tasks,
        key = lost === 'publication' ? 'appendIdempotent' : 'attachEntrustedWorkArtifactEvidence';
      const original = obj[key].bind(obj);
      let first = true;
      obj[key] = async (...args) => {
        const r = await original(...args);
        if (first) {
          first = false;
          throw Error('lost');
        }
        return r;
      };
      await assert.rejects(() => f.run(() => f.host.publishText(text)), /lost/);
      const a = await f.run(() => f.host.publishText(text));
      assert.deepEqual(await f.run(() => f.host.publishText(text)), a);
      assert.deepEqual((await f.tasks.get(f.task.id)).entrustedWork.artifactRefs, [a.artifactRef]);
      assert.equal((await f.tasks.get(f.task.id)).entrustedWork.revision, 2);
    });
  test('ordinary Task mutation during publication refuses attach', async () => {
    const f = await fixture(),
      append = f.messages.appendIdempotent.bind(f.messages);
    f.messages.appendIdempotent = async (...args) => {
      const r = await append(...args);
      await f.tasks.updateEntrustedWork(f.task.id, { expectedRevision: 1, artifactRefs: ['artifact:ordinary'] });
      return r;
    };
    await assert.rejects(() => f.run(() => f.host.publishText(text)));
    assert.deepEqual((await f.tasks.get(f.task.id)).entrustedWork.artifactRefs, ['artifact:ordinary']);
  });
});
