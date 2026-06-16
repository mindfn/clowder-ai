import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadInstalledPlugins } from '../dist/infrastructure/connectors/im-connector-loader.js';
import { resolvePluginsDir } from '../dist/infrastructure/connectors/plugins/plugin-installer.js';

const tempRoots = [];
const log = {
  info() {},
  warn() {},
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete globalThis.__moduleCacheProbeMarker;
});

function createPlugin(root, marker) {
  const pluginId = 'module-cache-probe';
  const pluginDir = join(resolvePluginsDir(root), pluginId);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'client.js'), `export const marker = ${JSON.stringify(marker)};\n`);
  writeFileSync(
    join(pluginDir, 'index.js'),
    `import { marker } from './client.js';
export default {
  id: '${pluginId}',
  definition: {
    id: '${pluginId}',
    displayName: marker,
    icon: { type: 'png', src: '/test.png' },
    themeColor: '#336699',
    description: marker,
  },
  requiredEnvKeys: [],
  isConfigured() { return true; },
  createAdapter() {
    globalThis.__moduleCacheProbeMarker = marker;
    return { id: '${pluginId}', sendMessage() {} };
  },
};
`,
  );
}

describe('loadInstalledPlugins', () => {
  it('loads updated dependency modules after an installed plugin update', async () => {
    const root = mkdtempSync(join(tmpdir(), 'im-loader-module-cache-'));
    tempRoots.push(root);

    createPlugin(root, 'v1');
    const first = await loadInstalledPlugins(root, log);
    assert.equal(first[0].definition.displayName, 'v1');

    createPlugin(root, 'v2');
    const second = await loadInstalledPlugins(root, log);

    assert.equal(
      second[0].definition.displayName,
      'v2',
      'updated sibling dependency modules must not stay pinned to the first import',
    );
  });
});
