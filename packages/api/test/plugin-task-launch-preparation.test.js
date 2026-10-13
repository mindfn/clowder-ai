import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { packageDirectoryName } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import { pluginTaskDispatchContent } from '../dist/domains/plugin/host-surface/plugin-task-receipt.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'task-launch-preparation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
  const binding = {
    version: 1,
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: 'task',
    taskRevision: 1,
    targetCatId: 'codex',
    threadId: 'thread',
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceMessageId: 'source',
    sourceRevision: 1,
    triggerMessageId: 'trigger',
    packageDigest: digest,
    lifecycleRevision: 1,
    grantRevision: 1,
  };
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'instance',
    contributionId: 'private',
    actionMethods: ['work.current', 'work.reply'],
  };
  const principal = {
    invocationId: 'invocation',
    userId: 'owner',
    catId: 'codex',
    threadId: 'thread',
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: 'trigger',
    pluginTaskBinding: binding,
    toolExecutionPolicy: policy,
  };
  const manifest = {
    pluginId: 'neutral',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Neutral',
    features: [
      {
        id: 'private',
        name: 'Private',
        capabilities: ['task.admitEntrusted'],
        resources: [],
        contributions: [
          { type: 'mcp', id: 'private' },
          { type: 'skill', id: 'task-skill' },
        ],
      },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'private',
        actions: [{ method: 'work.current' }, { method: 'work.reply' }],
        runtime: { transport: 'stdio', entrypoint: 'mcp.js' },
      },
      { type: 'skill', id: 'task-skill', path: 'skills/task' },
    ],
  };
  const instance = {
    pluginInstanceId: 'instance',
    pluginId: 'neutral',
    packageDigest: digest,
    lifecycleRevision: 1,
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
    runtimeState: 'healthy',
  };
  const pkg = { pluginId: 'neutral', packageDigest: digest, packageState: 'installed', manifest };
  const grant = { pluginInstanceId: 'instance', grantRevision: 1, effectiveGrants: ['task.admitEntrusted'] };
  const trigger = {
    id: 'trigger',
    userId: 'owner',
    catId: null,
    threadId: 'thread',
    content: pluginTaskDispatchContent(binding),
    timestamp: 1,
    mentions: [],
    deliveryStatus: 'queued',
  };
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'skills/task'), { recursive: true });
  await writeFile(join(packageRoot, 'skills/task/SKILL.md'), 'Task skill');
  const resourcesRoot = join(root, 'resources');
  const skills = join(
    resourcesRoot,
    createHash('sha256').update('neutral').digest('hex'),
    packageDirectoryName(digest),
    'skills',
  );
  await mkdir(join(skills, 'task'), { recursive: true });
  await writeFile(join(skills, 'task/SKILL.md'), 'Task skill');
  await writeFile(
    join(skills, '../.clowder-resource.json'),
    JSON.stringify({ pluginId: 'neutral', packageDigest: digest }),
  );
  const state = { current: true, checks: 0, nativeCalls: 0, beforeRead: async () => {}, beforeResolve: async () => {} };
  const server = {
    name: 'private',
    command: process.execPath,
    args: ['mcp.js'],
    workingDirectory: packageRoot,
    transport: 'stdio',
    env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'host-only-token' },
  };
  const workspaces = join(root, 'task-workspaces');
  const router = new PluginRuntimeCarrierRouter(
    { snapshot: async () => ({ instances: [instance], packages: [pkg], grants: [grant] }) },
    {
      projectRoot: root,
      resourcesRoot,
      configuration: { resolve: async () => ({}) },
      packages: {
        resolveInstalledPackage: async () => ({
          rootDir: packageRoot,
          manifest,
          verifyIntegrity: async () => {},
          release: async () => {},
        }),
      },
    },
    undefined,
    undefined,
    {
      ownerUserId: 'owner',
      messageStore: {
        getById: async (id) => {
          await state.beforeRead();
          return id === 'trigger' ? trigger : null;
        },
      },
    },
    workspaces,
  );
  router.resolveNativeMcpLaunch = async (request) => {
    state.nativeCalls++;
    await state.beforeResolve();
    assert.deepEqual(request, policy);
    return server;
  };
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent: async () => {
      state.checks++;
      if (!state.current) throw Error('revoked');
    },
  };
  const prepare = () => router.prepareTaskInvocationExecution(principal, authority);
  return {
    root,
    skills,
    workspaces,
    router,
    principal,
    binding,
    policy,
    instance,
    pkg,
    grant,
    trigger,
    state,
    server,
    authority,
    controller,
    prepare,
  };
}

test('Host Task launch preparation binds exact trigger, declared private MCP and persistent isolated workspace', async (t) => {
  const f = await fixture(t);
  const p = await f.prepare();
  assert.deepEqual(p.source, { messageId: 'trigger', content: f.trigger.content });
  assert.equal(p.launch.sandbox.kind, 'entrusted_work');
  assert.deepEqual(p.launch.sandbox.taskBinding, f.binding);
  assert.equal(p.launch.sandbox.runtimeSkillsRoot, f.skills);
  const workspace = p.launch.sandbox.workspaceRoot;
  assert.ok(workspace.startsWith(f.workspaces + '/'));
  assert.notEqual(workspace, f.server.workingDirectory);
  assert.ok(Object.isFrozen(p.launch.sandbox) && Object.isFrozen(p.launch.sandbox.taskBinding));
  await writeFile(join(workspace, 'result.txt'), 'owner-visible Task artifact');
  await p.launch.assertCurrent();
  await p.dispose();
  await assert.rejects(p.launch.assertCurrent());
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'owner-visible Task artifact');
});

test('launch currentness rejects independent trigger, installation, grant and private contribution drift permanently', async (t) => {
  const mutations = [
    (f) => {
      f.trigger.content += ' changed';
    },
    (f) => {
      f.trigger.deletedAt = 1;
    },
    (f) => {
      f.instance.lifecycleRevision++;
    },
    (f) => {
      f.grant.grantRevision++;
    },
    (f) => {
      f.grant.effectiveGrants = [];
    },
    (f) => {
      f.pkg.manifest.features[0].capabilities = ['task.read'];
    },
    (f) => {
      f.pkg.manifest.contributions[0].actions.pop();
    },
    (f) => {
      f.state.current = false;
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    const p = await f.prepare();
    mutate(f);
    await assert.rejects(p.launch.assertCurrent());
    f.state.current = true;
    await assert.rejects(p.launch.assertCurrent());
    await p.dispose();
  }
});

test('public policy without exact Host Task identity and malformed selectors cannot allocate', async (t) => {
  for (const change of [
    (f) => {
      delete f.principal.pluginTaskBinding;
    },
    (f) => {
      f.principal.userId = 'foreign';
    },
    (f) => {
      f.principal.toolExecutionPolicy = { mode: 'read_only' };
    },
    (f) => {
      f.principal.toolExecutionPolicy.actionMethods = ['ambient.tool'];
    },
    (f) => {
      f.pkg.manifest.features[0].capabilities = ['task.read'];
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await assert.rejects(f.prepare());
    assert.equal(f.state.nativeCalls, 0);
  }
});

test('preparation captures coordinates and authority callable before any await', async (t) => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise((r) => {
    entered = r;
  });
  const pause = new Promise((r) => {
    release = r;
  });
  let first = true;
  f.authority.assertCurrent = async () => {
    if (first) {
      first = false;
      entered();
      await pause;
    }
  };
  const pending = f.prepare();
  await waiting;
  f.principal.pluginTaskBinding = { ...f.binding, taskId: 'foreign' };
  f.authority.assertCurrent = async () => {
    throw Error('replaced');
  };
  release();
  const p = await pending;
  assert.equal(p.launch.sandbox.taskBinding.taskId, 'task');
  await p.dispose();
});

test('same child is not prepared twice and independent attempts never inherit prior workspace', async (t) => {
  const f = await fixture(t);
  const p = await f.prepare();
  await writeFile(join(p.launch.sandbox.workspaceRoot, 'result.txt'), 'keep');
  await p.dispose();
  await assert.rejects(f.prepare());
  f.principal.invocationId = 'next-attempt';
  const next = await f.prepare();
  assert.notEqual(next.launch.sandbox.workspaceRoot, p.launch.sandbox.workspaceRoot);
  await assert.rejects(readFile(join(next.launch.sandbox.workspaceRoot, 'result.txt')), { code: 'ENOENT' });
  await next.dispose();
});

test('workspace replacement, unsafe mode and skills symlinks fail closed without deleting artifacts', async (t) => {
  const f = await fixture(t);
  const p = await f.prepare();
  const workspace = p.launch.sandbox.workspaceRoot;
  await writeFile(join(workspace, 'artifact'), 'retained');
  await chmod(workspace, 0o777);
  await assert.rejects(p.launch.assertCurrent());
  await p.dispose();
  assert.equal(await readFile(join(workspace, 'artifact'), 'utf8'), 'retained');
  const g = await fixture(t);
  const q = await g.prepare();
  const original = q.launch.sandbox.workspaceRoot;
  await rename(original, original + '-saved');
  await symlink(original + '-saved', original);
  await assert.rejects(q.launch.assertCurrent());
  await q.dispose();
  const h = await fixture(t);
  await rename(h.skills, h.skills + '-saved');
  await symlink(h.skills + '-saved', h.skills);
  await assert.rejects(h.prepare());
});

test('cancellation or native descriptor replacement during an await poisons preparation', async (t) => {
  const f = await fixture(t);
  f.state.beforeResolve = async () => f.controller.abort();
  await assert.rejects(f.prepare());
  const g = await fixture(t);
  const p = await g.prepare();
  g.router.resolveNativeMcpLaunch = async () => ({ ...g.server });
  await assert.rejects(p.launch.assertCurrent());
  await p.dispose();
});

test('Queue adapter authenticates real Registry and sends runtime only a credential-free Task principal', async (t) => {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { createTaskQueueExecution } = await import('../dist/domains/plugin/carrier/task-queue-execution.js');
  const f = await fixture(t);
  const registry = new InvocationRegistry({
    turnExecutionStore: { get: async () => ({ status: 'running' }) },
    assertPluginTaskCurrent: f.authority.assertCurrent,
  });
  const creds = await registry.create(
    'owner',
    'codex',
    'thread',
    undefined,
    undefined,
    f.policy,
    'trigger',
    'unknown',
    undefined,
    undefined,
    f.binding,
  );
  let received;
  const prepare = f.router.prepareTaskInvocationExecution.bind(f.router);
  const port = createTaskQueueExecution(registry, () => ({
    prepareTaskInvocationExecution: (principal, context) => {
      received = principal;
      return prepare(principal, context);
    },
  }));
  const p = await port.prepare({
    invocationId: creds.invocationId,
    sourceMessageId: 'trigger',
    signal: f.controller.signal,
  });
  assert.equal('callbackToken' in received, false);
  assert.equal('clientMessageIds' in received, false);
  assert.ok(Object.isFrozen(received));
  await registry.create('owner', 'codex', 'thread');
  await assert.rejects(p.launch.assertCurrent());
  await p.dispose();
});

test('Queue adapter rejects ordinary/public, missing currentness and mismatched sources before runtime entry', async (t) => {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { createTaskQueueExecution } = await import('../dist/domains/plugin/carrier/task-queue-execution.js');
  for (const lane of ['ordinary', 'missing-checker', 'wrong-source']) {
    const f = await fixture(t);
    let calls = 0;
    const registry = new InvocationRegistry({
      turnExecutionStore: { get: async () => ({ status: 'running' }) },
      ...(lane === 'missing-checker' ? {} : { assertPluginTaskCurrent: async () => {} }),
    });
    const creds =
      lane === 'ordinary'
        ? await registry.create('owner', 'codex', 'thread')
        : await registry.create(
            'owner',
            'codex',
            'thread',
            undefined,
            undefined,
            f.policy,
            'trigger',
            'unknown',
            undefined,
            undefined,
            f.binding,
          );
    const port = createTaskQueueExecution(registry, () => ({
      prepareTaskInvocationExecution: async () => {
        calls++;
        throw Error('unexpected');
      },
    }));
    await assert.rejects(
      port.prepare({
        invocationId: creds.invocationId,
        sourceMessageId: lane === 'wrong-source' ? 'foreign' : 'trigger',
        signal: f.controller.signal,
      }),
    );
    assert.equal(calls, 0);
  }
});

test('Task skills must be exactly the installed declared members, never extra ambient files or edited copies', async (t) => {
  for (const change of [
    async (f) => writeFile(join(f.skills, 'task/SKILL.md'), 'changed'),
    async (f) => writeFile(join(f.skills, 'owner-note'), 'ambient'),
    async (f) => symlink(join(f.root, 'package/skills/task/SKILL.md'), join(f.skills, 'task/link')),
  ]) {
    const f = await fixture(t);
    await change(f);
    await assert.rejects(f.prepare());
  }
});
