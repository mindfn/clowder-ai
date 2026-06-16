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
