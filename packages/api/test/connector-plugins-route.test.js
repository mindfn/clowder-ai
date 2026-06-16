import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorPluginRoutes } = await import('../dist/routes/connector-plugins.js');

let previousConfigRoot;
const tempRoots = [];

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
  else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
  previousConfigRoot = undefined;

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function useTempConfigRoot() {
  previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const root = mkdtempSync(join(os.tmpdir(), 'connector-plugin-route-'));
  tempRoots.push(root);
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  return root;
}

describe('GET /api/connectors/plugins/:id/icon', () => {
  it('rejects icon paths that escape through a prefix sibling directory', async () => {
    const root = useTempConfigRoot();
    const pluginsDir = join(root, '.cat-cafe', 'plugins');
    const pluginDir = join(pluginsDir, 'a');
    const siblingDir = join(pluginsDir, 'abc');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, 'index.js'), 'neighbor-secret');
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        'id: a',
        'name: A',
        'nameEn: A',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: ../abc/index.js',
        'themeColor: "#336699"',
        'docsUrl: https://example.com/a',
        'config: []',
        'steps:',
        '  - text: Step',
      ].join('\n'),
    );

    const app = Fastify();
    await app.register(connectorPluginRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/connectors/plugins/a/icon' });

    assert.equal(res.statusCode, 404);
    assert.notEqual(res.body, 'neighbor-secret');

    await app.close();
  });
});

describe('GET /api/connectors/plugins', () => {
  it('requires a session identity before listing installed plugins', async () => {
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = Fastify();
    await app.register(connectorPluginRoutes);
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/api/connectors/plugins' });

      assert.equal(res.statusCode, 401);
      assert.match(res.body, /session/i);
      assert.doesNotMatch(res.body, /listed-plugin/);
    } finally {
      await app.close();
    }
  });

  it('does not expose installed plugin filesystem paths', async () => {
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    await app.register(connectorPluginRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/plugins',
        headers: { 'x-test-session-user': 'viewer-user' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.plugins.length, 1);
      assert.equal(body.plugins[0].id, 'listed-plugin');
      assert.equal(body.plugins[0].name, 'Listed Plugin');
      assert.equal(body.plugins[0].directory, undefined);
      assert.doesNotMatch(res.body, /\\.cat-cafe/);
    } finally {
      await app.close();
    }
  });
});
