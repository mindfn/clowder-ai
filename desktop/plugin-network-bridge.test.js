const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPluginNetworkBridge } = require('./plugin-network-bridge');
const ServiceManager = require('./service-manager');

async function request(endpoint, token, target) {
  return fetch(`${endpoint}/fetch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: target }),
  });
}

test('bridges the canonical catalog through Electron net.fetch on loopback', async (t) => {
  const calls = [];
  const bridge = createPluginNetworkBridge({
    netFetch: async (url, init) => {
      calls.push([String(url), init]);
      return new Response('{"plugins":[]}', {
        headers: { 'content-type': 'application/json', 'content-length': '14' },
      });
    },
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  const response = await request(
    binding.endpoint,
    binding.token,
    'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"plugins":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error');
});

test('rejects missing credentials and non-plugin destinations before Electron fetch', async (t) => {
  let calls = 0;
  const bridge = createPluginNetworkBridge({
    netFetch: async () => {
      calls += 1;
      return new Response('unexpected');
    },
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  const unauthorized = await fetch(`${binding.endpoint}/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://registry.npmjs.org/package.tgz' }),
  });
  const forbidden = await request(binding.endpoint, binding.token, 'https://example.com/private');

  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(calls, 0);
});

test('ServiceManager gives the API an ephemeral bridge credential and closes it with owned services', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-network-bridge-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const manager = new ServiceManager(userData, {
    frontendPort: 1,
    apiPort: 2,
    pluginNetworkFetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  });

  await manager._startPluginNetworkBridge();
  const env = manager._buildApiEnv(userData);
  const endpoint = env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL;
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN.length >= 32);

  await manager.stopAll();
  await assert.rejects(fetch(`${endpoint}/fetch`));
});
