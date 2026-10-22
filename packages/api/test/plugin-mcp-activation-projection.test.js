import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveInvocationMcpServers } from '../dist/config/capabilities/invoke-plugin-mcp.js';

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
  const resolve = () =>
    resolveInvocationMcpServers(project, 'codex-sol', {
      accessScope: 'project',
      capabilitiesProjectRoot: root,
    })[0];
  return { entry, project, host, path, save, resolve };
}

test('Host activation binding preserves project policy, overrides, and stored bytes', (t) => {
  const f = fixture(t);
  f.entry.mcpServerOverride = { command: 'custom-node', args: ['custom.mjs'], env: { ...f.entry.mcpServer.env } };
  const before = structuredClone(f.project);
  const hostBytes = readFileSync(f.path);
  let server = f.resolve();
  assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'current-activation');
  assert.equal(server.env.PLUGIN_CONFIG, 'project-value');
  assert.equal(server.command, 'custom-node');
  assert.deepEqual(server.args, ['custom.mjs']);
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

for (const kind of ['removed', 'wrong-owner', 'no-connection', 'unreadable']) {
  test(`a ${kind} Host activation cannot reuse project credentials`, (t) => {
    const f = fixture(t);
    if (kind === 'removed') f.host.capabilities = [];
    if (kind === 'wrong-owner') f.host.capabilities[0].pluginId = 'another-plugin';
    if (kind === 'no-connection') delete f.host.capabilities[0].mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN;
    f.save();
    if (kind === 'unreadable') writeFileSync(f.path, '{invalid');
    const server = f.resolve();
    assert.equal(server.enabled, false);
    assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
    assert.equal(f.entry.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'old-activation');
  });
}

test('user-owned MCP configuration does not receive a plugin connection', (t) => {
  const f = fixture(t);
  delete f.entry.pluginId;
  f.entry.source = 'user';
  assert.equal(f.resolve().env.CLOWDER_PLUGIN_ACTION_TOKEN, 'old-activation');
});
