import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindHostPluginMcpSource, resolveInvocationMcpServers } from '../dist/config/capabilities/invoke-plugin-mcp.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-connection-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.cat-cafe'));
  const path = join(root, '.cat-cafe/capabilities.json');
  const entry = {
    id: 'plugin:fixture:native',
    type: 'mcp',
    source: 'cat-cafe',
    pluginId: 'fixture',
    globalEnabled: true,
    blockedCats: [],
    mcpServer: {
      command: 'node',
      args: ['plugin.mjs'],
      env: {
        CLOWDER_PLUGIN_ACTION_TOKEN: 'old-activation',
        CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
        PLUGIN_CONFIG: 'project-value',
      },
    },
  };
  const project = { version: 2, capabilities: [entry] };
  const host = structuredClone(project);
  host.capabilities[0].mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'current-activation';
  const save = () => writeFileSync(path, JSON.stringify(host));
  save();
  const release = bindHostPluginMcpSource((id) => {
    const candidates = host.capabilities.filter((c) => c.id === id && c.pluginId === 'fixture');
    const c = candidates[0];
    if (candidates.length !== 1 || !c?.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN) return undefined;
    return {
      name: id.replaceAll(':', '__'),
      command: c.mcpServer.command,
      args: c.mcpServer.args,
      env: c.mcpServer.env,
      workingDirectory: root,
      transport: 'stdio',
    };
  });
  t.after(release);
  const resolve = () =>
    resolveInvocationMcpServers(project, 'codex-sol', {
      accessScope: 'project',
    })[0];
  return { entry, project, host, path, save, resolve, release };
}

test('Host activation binding preserves project policy and stored bytes', (t) => {
  const f = fixture(t);
  const before = structuredClone(f.project);
  const hostBytes = readFileSync(f.path);
  let server = f.resolve();
  assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
  assert.equal(server.env.PLUGIN_CONFIG, 'project-value');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['plugin.mjs']);
  assert.equal(server.enabled, true);
  assert.deepEqual(f.project, before);
  assert.deepEqual(readFileSync(f.path), hostBytes);
  f.entry.blockedCats = ['codex-sol'];
  assert.equal(f.resolve().enabled, false);
  f.entry.blockedCats = ['codex-sol', 'another-cat'];
  assert.equal(f.resolve().enabled, false);
  f.entry.blockedCats = [];
  f.host.capabilities[0].mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'next-activation';
  f.save();
  server = f.resolve();
  assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'next-activation');
  assert.equal(f.entry.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'old-activation');
});

for (const kind of ['removed', 'wrong-owner', 'no-connection', 'runtime-unavailable']) {
  test(`a ${kind} Host activation cannot reuse project credentials`, (t) => {
    const f = fixture(t);
    if (kind === 'removed') f.host.capabilities = [];
    if (kind === 'wrong-owner') f.host.capabilities[0].pluginId = 'another-plugin';
    if (kind === 'no-connection') delete f.host.capabilities[0].mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN;
    f.save();
    if (kind === 'runtime-unavailable') f.release();
    const server = f.resolve();
    assert.equal(server.enabled, false);
    assert.equal(server.env?.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
    assert.equal(f.entry.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'old-activation');
  });
}

test('user-owned MCP configuration does not receive a plugin connection', (t) => {
  const f = fixture(t);
  delete f.entry.pluginId;
  f.entry.source = 'user';
  assert.equal(f.resolve().env.CLOWDER_PLUGIN_ACTION_TOKEN, 'old-activation');
});

for (const kind of ['override', 'source', 'missing-owner', 'duplicate-project', 'duplicate-host']) {
  test(`project ${kind} cannot receive a fresh Host connection`, (t) => {
    const f = fixture(t);
    if (kind === 'override')
      f.entry.mcpServerOverride = { ...f.entry.mcpServer, command: 'project-controlled-command' };
    if (kind === 'command') f.entry.mcpServer.command = 'project-controlled-command';
    if (kind === 'args') f.entry.mcpServer.args = ['project-controlled.mjs'];
    if (kind === 'workingDir') f.entry.mcpServer.workingDir = '/project-controlled';
    if (kind === 'source') f.entry.source = 'external';
    if (kind === 'missing-owner') {
      delete f.entry.pluginId;
      delete f.host.capabilities[0].pluginId;
      f.entry.source = 'plugin';
      f.host.capabilities[0].source = 'plugin';
    }
    if (kind === 'duplicate-project') f.project.capabilities.push(structuredClone(f.entry));
    if (kind === 'duplicate-host') f.host.capabilities.push(structuredClone(f.host.capabilities[0]));
    f.save();
    const server = f.resolve();
    assert.equal(server.enabled, false);
    assert.equal(server.env?.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
  });
}

test('project environment cannot modify the Host-owned plugin executable environment', (t) => {
  const f = fixture(t);
  f.entry.mcpServer.env.NODE_OPTIONS = '--import=./project-controlled.mjs';
  f.entry.mcpServer.env.PLUGIN_CONFIG = 'stale-project-value';
  const server = f.resolve();
  assert.equal(server.enabled, true);
  assert.equal(server.env.NODE_OPTIONS, undefined);
  assert.equal(server.env.PLUGIN_CONFIG, 'project-value');
  assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
});

test('persisted Host credentials are not read when the live launch is available', (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{invalid');
  assert.equal(f.resolve().env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
});

test('project transport drift never chooses an executable and cannot block the live Host launch', (t) => {
  const f = fixture(t);
  f.entry.mcpServer.command = 'project-controlled-command';
  f.entry.mcpServer.args = ['project-controlled.mjs'];
  f.entry.mcpServer.workingDir = '/project-controlled';
  f.host.capabilities[0].mcpServer.args = ['new-host-version.mjs'];
  const server = f.resolve();
  assert.equal(server.enabled, true);
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['new-host-version.mjs']);
  assert.notEqual(server.workingDir, '/project-controlled');
  assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
});

test('the persisted plugin environment has no credential-consumption path', (t) => {
  const f = fixture(t);
  Object.defineProperty(f.entry.mcpServer, 'env', {
    get() {
      throw new Error('persisted plugin environment must not be read');
    },
  });
  assert.equal(f.resolve().env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
});

test('closing a previous Host cannot disconnect the current manager read port', (t) => {
  const f = fixture(t);
  const replacement = {
    name: 'plugin__fixture__native',
    command: 'current-host-node',
    args: ['verified-plugin.mjs'],
    env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'replacement-host-connection' },
    transport: 'stdio',
  };
  const releaseCurrent = bindHostPluginMcpSource((id) => (id === f.entry.id ? replacement : undefined));
  t.after(releaseCurrent);
  f.release();
  assert.equal(f.resolve().command, replacement.command);
  assert.equal(f.resolve().env.CLOWDER_PLUGIN_ACTION_TOKEN, replacement.env.CLOWDER_PLUGIN_ACTION_TOKEN);
  releaseCurrent();
  assert.equal(f.resolve().enabled, false);
  assert.equal(f.resolve().env?.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
});
