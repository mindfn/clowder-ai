import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  loadAllPluginConfigs,
  readPluginConfig,
  writePluginConfig,
} from '../dist/domains/plugin/plugin-config-store.js';

describe('plugin-config-store', () => {
  let tmpDir;
  const savedEnv = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-cfg-'));
    mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function trackEnv(name) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  }

  it('readPluginConfig returns empty object for missing file', () => {
    const result = readPluginConfig(tmpDir, 'nonexistent');
    assert.deepEqual(result, {});
  });

  it('writePluginConfig creates JSON file and updates process.env', () => {
    trackEnv('TEST_PLUGIN_KEY');
    trackEnv('TEST_PLUGIN_SECRET');

    const { changedKeys } = writePluginConfig(tmpDir, 'test-plugin', [
      { name: 'TEST_PLUGIN_KEY', value: 'abc123' },
      { name: 'TEST_PLUGIN_SECRET', value: 'secret456' },
    ]);

    assert.deepEqual(changedKeys, ['TEST_PLUGIN_KEY', 'TEST_PLUGIN_SECRET']);
    assert.equal(process.env.TEST_PLUGIN_KEY, 'abc123');
    assert.equal(process.env.TEST_PLUGIN_SECRET, 'secret456');

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_KEY, 'abc123');
    assert.equal(stored.TEST_PLUGIN_SECRET, 'secret456');
  });

  it('writePluginConfig merges with existing config', () => {
    trackEnv('TEST_PLUGIN_A');
    trackEnv('TEST_PLUGIN_B');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_A', value: 'first' }]);
    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_B', value: 'second' }]);

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_A, 'first');
    assert.equal(stored.TEST_PLUGIN_B, 'second');
  });

  it('writePluginConfig removes key when value is null', () => {
    trackEnv('TEST_PLUGIN_REMOVE');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: 'exists' }]);
    assert.equal(process.env.TEST_PLUGIN_REMOVE, 'exists');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: null }]);
    assert.equal(process.env.TEST_PLUGIN_REMOVE, undefined);

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_REMOVE, undefined);
  });

  it('writePluginConfig reports no changes when values are identical', () => {
    trackEnv('TEST_PLUGIN_SAME');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_SAME', value: 'unchanged' }]);
    const { changedKeys } = writePluginConfig(tmpDir, 'test-plugin', [
      { name: 'TEST_PLUGIN_SAME', value: 'unchanged' },
    ]);

    assert.deepEqual(changedKeys, []);
  });

  it('loadAllPluginConfigs populates process.env', () => {
    trackEnv('TEST_PLUGIN_LOAD');

    writePluginConfig(tmpDir, 'load-test', [{ name: 'TEST_PLUGIN_LOAD', value: 'loaded' }]);
    delete process.env.TEST_PLUGIN_LOAD;

    const count = loadAllPluginConfigs(tmpDir, ['load-test']);
    assert.equal(count, 1);
    assert.equal(process.env.TEST_PLUGIN_LOAD, 'loaded');
  });

  it('JSON file has restricted permissions (0o600)', () => {
    trackEnv('TEST_PLUGIN_PERMS');

    writePluginConfig(tmpDir, 'perm-test', [{ name: 'TEST_PLUGIN_PERMS', value: 'secret' }]);

    const configPath = join(tmpDir, '.cat-cafe', 'plugin-config', 'perm-test.json');
    assert.ok(existsSync(configPath));

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.TEST_PLUGIN_PERMS, 'secret');
  });

  it('each plugin gets its own config file', () => {
    trackEnv('PLUGIN_A_KEY');
    trackEnv('PLUGIN_B_KEY');

    writePluginConfig(tmpDir, 'plugin-a', [{ name: 'PLUGIN_A_KEY', value: 'a' }]);
    writePluginConfig(tmpDir, 'plugin-b', [{ name: 'PLUGIN_B_KEY', value: 'b' }]);

    const a = readPluginConfig(tmpDir, 'plugin-a');
    const b = readPluginConfig(tmpDir, 'plugin-b');
    assert.equal(a.PLUGIN_A_KEY, 'a');
    assert.equal(a.PLUGIN_B_KEY, undefined);
    assert.equal(b.PLUGIN_B_KEY, 'b');
    assert.equal(b.PLUGIN_A_KEY, undefined);
  });
});
