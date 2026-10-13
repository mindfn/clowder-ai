import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { buildCodexNativeEffectGuardArgs } from '../src/domains/cats/services/agents/providers/CodexNativeEffectGuard.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerNativeTurnAdmissionRoute } from '../src/routes/callback-native-turn-admission.ts';

const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'scripts/plugin-task-effect-guard.mjs');

test('Host Task hook selection requires an explicit protected admission file and keeps ordinary hook unchanged', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'c1-task-hook-'));
  const credentials = join(scratch, 'admission.json');
  await writeFile(credentials, '{}', { mode: 0o600 });
  const normal = buildCodexNativeEffectGuardArgs({ repoRoot: root });
  const privateArgs = buildCodexNativeEffectGuardArgs({ repoRoot: root, taskAdmissionFile: credentials });
  assert.match(privateArgs.join(' '), /plugin-task-effect-guard\.mjs/);
  assert.ok(privateArgs.join(' ').includes('admission.json'));
  assert.match(normal.join(' '), /native-effect-target-guard\.mjs/);
  assert.doesNotMatch(normal.join(' '), /admission\.json/);
  assert.notEqual(privateArgs.at(-1), normal.at(-1), 'trusted hook hash and command must cover private admission');
});

async function run(file, payload) {
  return new Promise((resolveResult, reject) => {
    const p = spawn(process.execPath, [script, file], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir() },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 6000,
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    p.stdin.end(JSON.stringify(payload));
  });
}

test('actual private hook combines static sanctuary with Task scope, denies revoked credentials and leaks no bearer', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'c1-task-hook-http-'));
  let current = true,
    checks = 0;
  const registry = new InvocationRegistry({
    turnExecutionStore: { get: async () => ({ status: 'running' }) },
    assertPluginTaskCurrent: async () => {
      checks++;
      if (!current) throw Error('closed');
    },
  });
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
    triggerMessageId: 'dispatch',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
  };
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'instance',
    contributionId: 'private',
    actionMethods: ['work.read'],
  };
  const creds = await registry.create(
    'owner',
    'codex',
    'thread',
    undefined,
    undefined,
    policy,
    'dispatch',
    'unknown',
    undefined,
    undefined,
    binding,
  );
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerNativeTurnAdmissionRoute(app, registry);
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const file = join(scratch, 'admission.json');
  await writeFile(file, JSON.stringify({ apiUrl, ...creds }), { mode: 0o600 });
  const payload = { tool_name: 'Bash', tool_input: { command: 'printf hello' }, cwd: scratch };
  const accepted = await run(file, payload);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.stdout, '');
  assert.equal(accepted.stderr, '');
  assert.ok(checks >= 2);
  const before = checks;
  const forbidden = await run(file, { ...payload, tool_input: { command: 'redis-cli -p 6399 FLUSHALL' } });
  assert.equal(JSON.parse(forbidden.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(checks, before, 'static denial never calls admission');
  current = false;
  const revoked = await run(file, payload);
  assert.equal(JSON.parse(revoked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  current = true;
  const restored = await run(file, payload);
  assert.equal(JSON.parse(restored.stdout).hookSpecificOutput.permissionDecision, 'deny');
  for (const output of [accepted, forbidden, revoked, restored])
    assert.ok(!JSON.stringify(output).includes(creds.callbackToken));
});

test('hook rejects non204, redirect, unsafe credential file and unavailable Host without exposing secrets', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'c1-task-hook-refuse-'));
  let status = 200,
    hits = 0;
  const app = Fastify();
  app.get('/api/callbacks/native-turn-admission', async (request, reply) => {
    hits++;
    assert.equal(request.query.scope, 'plugin_task');
    if (status === 302) reply.header('location', '/redirected');
    return reply.status(status).send();
  });
  app.get('/redirected', async () => {
    throw Error('must not follow redirect');
  });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const file = join(scratch, 'admission.json'),
    c = { apiUrl, invocationId: 'test-inv', callbackToken: 'fixture-only-secret' };
  await writeFile(file, JSON.stringify(c), { mode: 0o600 });
  const payload = { tool_name: 'Write', tool_input: { file_path: join(scratch, 'output.txt') }, cwd: scratch };
  const denied = async (path) => {
    const result = await run(path, payload);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!JSON.stringify(result).includes(c.callbackToken));
  };
  for (const value of [200, 401, 403, 500, 302]) {
    status = value;
    await denied(file);
  }
  assert.equal(hits, 5);
  await chmod(file, 0o644);
  await denied(file);
  assert.equal(hits, 5);
  await chmod(file, 0o600);
  const link = join(scratch, 'symlink.json');
  await symlink(file, link);
  await denied(link);
  assert.equal(hits, 5);
  await writeFile(file, JSON.stringify({ ...c, apiUrl: 'https://example.invalid' }));
  await denied(file);
  assert.equal(hits, 5);
  await writeFile(file, JSON.stringify({ ...c, extra: 'untrusted' }));
  await denied(file);
  assert.equal(hits, 5);
  await writeFile(file, JSON.stringify(c));
  await app.close();
  await denied(file);
});
