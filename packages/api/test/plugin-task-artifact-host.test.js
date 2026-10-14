import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import { isHostReservedDataDirectoryName } from '../src/domains/plugin/host-inventory/data-directory-name.ts';
import { createPluginTaskArtifactHost } from '../src/domains/plugin/host-surface/plugin-task-artifact-host.ts';
import { uploadsRoutes } from '../src/routes/uploads.ts';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

async function fixture() {
  const messages = new MessageStore(),
    tasks = new TaskStore();
  const { task } = tasks.admitEntrustedWork({
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
const text = { text: '# Report\n猫的结果', mediaType: 'text/markdown' };
test('publish persists exact callback publication, attaches evidence without epoch change, reads sealed bytes and replays', async () => {
  const f = await fixture();
  assert.equal(typeof f.host.publishText, 'function');
  const a = await f.run(() => f.host.publishText(text));
  assert.equal(a.seal.executionRef, 'message:execution');
  assert.equal(a.seal.invocationId, 'child');
  assert.equal(a.seal.byteLength, Buffer.byteLength(text.text));
  assert.equal(f.tasks.get(f.task.id).entrustedWork.revision, 2);
  assert.equal(f.tasks.get(f.task.id).entrustedWork.executionAuthorityRevision, 1);
  assert.deepEqual(await f.run(() => f.host.publishText(text)), a);
  assert.equal(
    (await f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef }))).text,
    text.text,
  );
  assert.equal(f.messages.getById(a.publicationRef.slice(8)).origin, 'callback');
  assert.equal((await readdir(f.taskArtifactDirectory)).length, 1);
});
for (const mode of [
  'no-native',
  'no-binding',
  'legacy',
  'wrong-owner',
  'wrong-thread',
  'wrong-trigger',
  'wrong-instance',
  'no-policy',
  'revoked',
  'no-write',
])
  test(`publish rejects ${mode} before file or message effects`, async () => {
    const f = await fixture();
    const ctx = { ...f.native };
    if (mode === 'no-binding') delete ctx.readTaskBinding;
    if (mode === 'legacy') {
      f.binding.version = 1;
      delete f.binding.executionAuthorityRevision;
      delete f.binding.executionReceiptDigest;
    }
    if (mode === 'wrong-owner') ctx.userId = 'other';
    if (mode === 'wrong-thread') ctx.threadId = 'public';
    if (mode === 'wrong-trigger') ctx.originTriggerMessageId = 'other';
    if (mode === 'wrong-instance') f.binding.pluginInstanceId = 'other';
    if (mode === 'no-policy') delete ctx.toolExecutionPolicy;
    if (mode === 'revoked') f.revoke();
    if (mode === 'no-write') f.grants(['task.read', 'thread.readContent']);
    await assert.rejects(() =>
      mode === 'no-native' ? f.host.publishText(text) : f.run(() => f.host.publishText(text), ctx),
    );
    assert.deepEqual(await readdir(f.taskArtifactDirectory), []);
    assert.deepEqual(f.tasks.get(f.task.id).entrustedWork.artifactRefs, []);
  });
for (const input of [
  { ...text, text: '界'.repeat(22000) },
  { ...text, text: 'bad\0text' },
  { ...text, text: 'bad\ud800' },
  { ...text, taskId: 'other' },
  { ...text, mediaType: 'application/javascript' },
])
  test('strict bounded text rejects invalid or authority-bearing input before effects', async () => {
    const f = await fixture();
    await assert.rejects(() => f.run(() => f.host.publishText(input)));
    assert.deepEqual(await readdir(f.taskArtifactDirectory), []);
  });
for (const mode of [
  'recall',
  'tombstone',
  'queued',
  'wrong-invocation',
  'wrong-trigger',
  'duplicate-file',
  'missing-ref',
  'changed-bytes',
  'symlink',
  'index-loss',
])
  test(`read rejects ${mode}`, async () => {
    const f = await fixture(),
      a = await f.run(() => f.host.publishText(text));
    const m = f.messages.getById(a.publicationRef.slice(8));
    if (mode === 'recall') m.recall = {};
    if (mode === 'tombstone') m._tombstone = true;
    if (mode === 'queued') m.deliveryStatus = 'queued';
    if (mode === 'wrong-invocation') m.extra.stream.turnInvocationId = 'other';
    if (mode === 'wrong-trigger') m.extra.causal.triggerMessageId = 'other';
    if (mode === 'duplicate-file') m.extra.rich.blocks.push({ ...m.extra.rich.blocks[0], id: 'duplicate' });
    if (mode === 'missing-ref') f.tasks.get(f.task.id).entrustedWork.artifactRefs = [];
    if (mode === 'changed-bytes')
      await writeFile(join(f.taskArtifactDirectory, a.artifactRef.slice('task-artifact:'.length)), 'changed');
    if (mode === 'symlink') {
      const path = join(f.taskArtifactDirectory, a.artifactRef.slice('task-artifact:'.length));
      await unlink(path);
      const target = join(f.taskArtifactDirectory, 'target.md');
      await writeFile(target, text.text);
      await symlink(target, path);
    }
    if (mode === 'index-loss') f.messages.getByIdempotencyKey = () => null;
    await assert.rejects(() =>
      f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef })),
    );
  });
test('failed attach leaves orphan publication, and exact retry recovers the same durable publication', async () => {
  const f = await fixture(),
    attach = f.tasks.attachEntrustedWorkArtifactEvidence.bind(f.tasks);
  f.tasks.attachEntrustedWorkArtifactEvidence = () => {
    throw Error('store unavailable');
  };
  await assert.rejects(() => f.run(() => f.host.publishText(text)), /store unavailable/);
  assert.deepEqual(f.tasks.get(f.task.id).entrustedWork.artifactRefs, []);
  f.tasks.attachEntrustedWorkArtifactEvidence = attach;
  const a = await f.run(() => f.host.publishText(text));
  assert.deepEqual(await f.run(() => f.host.publishText(text)), a);
  assert.equal(f.tasks.get(f.task.id).entrustedWork.revision, 2);
});
test('attach response loss recovers without duplicate ref or epoch change', async () => {
  const f = await fixture(),
    attach = f.tasks.attachEntrustedWorkArtifactEvidence.bind(f.tasks);
  let first = true;
  f.tasks.attachEntrustedWorkArtifactEvidence = (...args) => {
    const r = attach(...args);
    if (first) {
      first = false;
      throw Error('lost response');
    }
    return r;
  };
  await assert.rejects(() => f.run(() => f.host.publishText(text)), /lost response/);
  const a = await f.run(() => f.host.publishText(text));
  assert.equal(f.tasks.get(f.task.id).entrustedWork.revision, 2);
  assert.deepEqual(f.tasks.get(f.task.id).entrustedWork.artifactRefs, [a.artifactRef]);
});
test('revocation after durable publication prevents attach and returns no seal', async () => {
  const f = await fixture(),
    append = f.messages.appendIdempotent.bind(f.messages);
  f.messages.appendIdempotent = (...args) => {
    const r = append(...args);
    f.revoke();
    return r;
  };
  await assert.rejects(() => f.run(() => f.host.publishText(text)), /revoked/);
  assert.deepEqual(f.tasks.get(f.task.id).entrustedWork.artifactRefs, []);
});

test('another execution or invocation cannot reuse the same Task artifact', async () => {
  const f = await fixture(),
    a = await f.run(() => f.host.publishText(text));
  f.binding.executionRef = 'message:another-execution';
  await assert.rejects(() =>
    f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef })),
  );
  f.binding.executionRef = 'message:execution';
  await assert.rejects(() =>
    f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef }), {
      ...f.native,
      invocationId: 'other-child',
    }),
  );
});
test('revocation after Task attach leaves evidence but does not return a usable seal', async () => {
  const f = await fixture(),
    attach = f.tasks.attachEntrustedWorkArtifactEvidence.bind(f.tasks);
  f.tasks.attachEntrustedWorkArtifactEvidence = (...args) => {
    const r = attach(...args);
    f.revoke();
    return r;
  };
  await assert.rejects(() => f.run(() => f.host.publishText(text)), /revoked/);
  assert.equal(f.tasks.get(f.task.id).entrustedWork.artifactRefs.length, 1);
});
test('read requires current capabilities and an open exact Task even if the callback fixture is live', async () => {
  const f = await fixture(),
    a = await f.run(() => f.host.publishText(text));
  f.grants([]);
  await assert.rejects(
    () => f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef })),
    /capability/,
  );
  f.grants(['task.read', 'thread.readContent']);
  f.tasks.get(f.task.id).status = 'done';
  await assert.rejects(() =>
    f.run(() => f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef })),
  );
});

for (const ending of ['revoked', 'closed']) {
  test(`production Task artifact is private from static HTTP before and after ${ending}`, async (t) => {
    const f = await fixture();
    const publicUploads = await mkdtemp(join(tmpdir(), 'task-public-uploads-'));
    const previous = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = publicUploads;
    t.after(() => {
      if (previous === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = previous;
    });
    const g = await neutralFixture(t, {
      taskStore: f.tasks,
      messageStore: f.messages,
      capabilities: ['task.read', 'task.write', 'thread.readContent', 'thread.write', 'media.read'],
    });
    f.binding.pluginInstanceId = g.installed.pluginInstanceId;
    f.native.toolExecutionPolicy = {
      mode: 'plugin_native',
      pluginInstanceId: g.installed.pluginInstanceId,
      contributionId: 'native',
      actionMethods: ['neutral.call'],
    };
    const call = async (method, value) => (await g.native('taskArtifacts', method, value, f.native)).result;
    const a = await call('publishText', text);
    const selection = { artifactRef: a.artifactRef, publicationRef: a.publicationRef };
    assert.equal((await call('readText', selection)).text, text.text);
    await assert.rejects(() =>
      g.native('media', 'read', { reference: a.artifactRef, offset: 0, limit: 65536 }, f.native),
    );
    const publication = f.messages.getById(a.publicationRef.slice(8));
    const file = publication.extra.rich.blocks[0];
    const app = Fastify();
    t.after(() => app.close());
    await app.register(uploadsRoutes, { uploadDir: publicUploads });
    const noPublicBytes = async () => {
      for (const url of [
        `/uploads/${file.fileName}`,
        `/${a.artifactRef}`,
        `/uploads/${encodeURIComponent(a.artifactRef)}`,
      ]) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 404, `unauthenticated ${url}: ${response.body}`);
        assert.equal(response.body.includes(text.text), false);
      }
    };
    await noPublicBytes();
    assert.match(a.artifactRef, /^task-artifact:task-/);
    assert.equal(file.url, a.artifactRef);
    assert.deepEqual(await readdir(publicUploads), []);
    assert.deepEqual(await readdir(join(g.root, '.cat-cafe', 'plugin-host', 'task-artifacts')), [file.fileName]);
    if (ending === 'revoked') f.revoke();
    else f.tasks.get(f.task.id).status = 'done';
    await assert.rejects(() => call('readText', selection));
    await noPublicBytes();
  });
}
test('Task artifact private directory cannot be claimed by a module data.directory grant', () => {
  assert.equal(isHostReservedDataDirectoryName('task-artifacts'), true);
});

for (const operation of ['publish', 'read']) {
  test(`private directory symlink is rejected on ${operation}`, async () => {
    const f = await fixture();
    const a = operation === 'read' ? await f.run(() => f.host.publishText(text)) : undefined;
    const moved = `${f.taskArtifactDirectory}-moved`;
    await rename(f.taskArtifactDirectory, moved);
    await symlink(moved, f.taskArtifactDirectory);
    await assert.rejects(
      () =>
        f.run(() =>
          a
            ? f.host.readText({ publicationRef: a.publicationRef, artifactRef: a.artifactRef })
            : f.host.publishText(text),
        ),
      /private directory/,
    );
    if (!a) assert.deepEqual(await readdir(moved), []);
  });
}
test('public upload coordinates cannot be used as private Task refs', async () => {
  const f = await fixture();
  const a = await f.run(() => f.host.publishText(text));
  await assert.rejects(
    () =>
      f.run(() =>
        f.host.readText({
          publicationRef: a.publicationRef,
          artifactRef: a.artifactRef.replace('task-artifact:', '/uploads/'),
        }),
      ),
    /scope mismatch/,
  );
});
