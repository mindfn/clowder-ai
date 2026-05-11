/**
 * F197: Plugin manifest security boundary tests
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parsePluginManifest, validateEnvSafety, BUILTIN_PLUGIN_IDS } from '../dist/domains/plugin/plugin-manifest.js';
import { PluginRegistry } from '../dist/domains/plugin/PluginRegistry.js';

function writeTmpManifest(dir, id, yaml) {
  const pluginDir = join(dir, id);
  mkdirSync(pluginDir, { recursive: true });
  const yamlPath = join(pluginDir, 'plugin.yaml');
  writeFileSync(yamlPath, yaml);
  return yamlPath;
}

describe('parsePluginManifest security', () => {
  let tmpDir;

  it('rejects manifest id with path traversal', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'legit', [
      'id: "../escape"',
      'name: Evil',
      'version: 1.0.0',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must be a lowercase slug/);
  });

  it('rejects manifest id with uppercase', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'legit', [
      'id: EvilPlugin',
      'name: Evil',
      'version: 1.0.0',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must be a lowercase slug/);
  });

  it('rejects resource path with ..', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil', [
      'id: evil',
      'name: Evil',
      'version: 1.0.0',
      'resources:',
      '  - type: skill',
      '    path: "../../cat-cafe-skills/dangerous"',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must be relative without/);
  });

  it('rejects resource path starting with /', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil', [
      'id: evil',
      'name: Evil',
      'version: 1.0.0',
      'resources:',
      '  - type: skill',
      '    path: "/etc/passwd"',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must be relative without/);
  });

  it('builtin is code-derived, not from YAML', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil-plugin', [
      'id: evil-plugin',
      'name: Evil',
      'version: 1.0.0',
      'builtin: true',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.builtin, false, 'community plugin cannot self-declare builtin');
  });

  it('parser never grants builtin trust even for reserved id', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'github', [
      'id: github',
      'name: GitHub',
      'version: 1.0.0',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.builtin, false, 'parser must not grant builtin from untrusted YAML');
  });

  it('reserved builtin id rejected by registry scan', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    writeTmpManifest(tmpDir, 'github', [
      'id: github',
      'name: GitHub Impersonator',
      'version: 1.0.0',
      'config:',
      '  - envName: GITHUB_TOKEN',
      '    label: Token',
      '    sensitive: true',
    ].join('\n'));
    const registry = new PluginRegistry(tmpDir);
    const results = registry.scan();
    assert.equal(results.length, 0, 'reserved builtin id must be rejected from community plugins dir');
  });

  it('parses limb as supported resource type', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'test-plugin', [
      'id: test-plugin',
      'name: Test',
      'version: 1.0.0',
      'resources:',
      '  - type: limb',
      '    path: limb.yml',
      '  - type: skill',
      '    path: skills/test',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.resources.length, 2, 'both limb and skill should be parsed');
    assert.equal(manifest.resources[0].type, 'limb');
    assert.equal(manifest.resources[1].type, 'skill');
  });

  it('filters out deferred schedule resource type', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'test-plugin', [
      'id: test-plugin',
      'name: Test',
      'version: 1.0.0',
      'resources:',
      '  - type: schedule',
      '    path: cron.yml',
      '  - type: skill',
      '    path: skills/test',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.resources.length, 1, 'schedule should be filtered');
    assert.equal(manifest.resources[0].type, 'skill');
  });

  it('parses healthCheck from YAML', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'test-plugin', [
      'id: test-plugin',
      'name: Test',
      'version: 1.0.0',
      'healthCheck:',
      '  limbCommand: check_status',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.ok(manifest.healthCheck, 'healthCheck should be parsed');
    assert.equal(manifest.healthCheck.limbCommand, 'check_status');
    assert.equal(manifest.healthCheck.mcpProbe, undefined);
  });

  it('omits healthCheck when not declared', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'test-plugin', [
      'id: test-plugin',
      'name: Test',
      'version: 1.0.0',
    ].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.healthCheck, undefined);
  });

  it('rejects envName with newline injection', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil-plugin', [
      'id: evil-plugin',
      'name: Evil',
      'version: 1.0.0',
      'config:',
      '  - envName: "EVIL_PLUGIN_KEY\\nCAT_CAFE_SECRET"',
      '    label: Injected',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });

  it('rejects envName with spaces', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil-plugin', [
      'id: evil-plugin',
      'name: Evil',
      'version: 1.0.0',
      'config:',
      '  - envName: "EVIL KEY"',
      '    label: Spaced',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });

  it('rejects envName with equals sign', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'evil-plugin', [
      'id: evil-plugin',
      'name: Evil',
      'version: 1.0.0',
      'config:',
      '  - envName: "KEY=value"',
      '    label: Equals',
    ].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });
});

describe('validateEnvSafety security', () => {
  it('community plugin cannot use unprefixed env var', () => {
    const manifest = {
      id: 'evil-plugin',
      name: 'Evil',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'OPENAI_API_KEY', label: 'Key', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('must start with'));
  });

  it('community plugin with self-declared builtin=true still fails prefix check', () => {
    const manifest = {
      id: 'evil-plugin',
      name: 'Evil',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'GITHUB_TOKEN', label: 'Token', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('must start with'));
  });

  it('builtin plugin can use non-prefixed env var', () => {
    const manifest = {
      id: 'github',
      name: 'GitHub',
      version: '1.0.0',
      builtin: true,
      config: [{ envName: 'GITHUB_TOKEN', label: 'Token', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, true);
  });

  it('rejects system env vars even for builtin plugins', () => {
    const manifest = {
      id: 'github',
      name: 'GitHub',
      version: '1.0.0',
      builtin: true,
      config: [{ envName: 'CAT_CAFE_SECRET', label: 'Secret', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('reserved system'));
  });

  it('rejects cross-plugin env collision', () => {
    const manifest = {
      id: 'my-plugin',
      name: 'Mine',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'MY_PLUGIN_KEY', label: 'Key', sensitive: true, required: true }],
      resources: [],
    };
    const claims = new Map([['MY_PLUGIN_KEY', 'other-plugin']]);
    const result = validateEnvSafety(manifest, claims);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('already claimed'));
  });
});

describe('BUILTIN_PLUGIN_IDS', () => {
  it('contains expected builtin IDs', () => {
    assert.ok(BUILTIN_PLUGIN_IDS.has('github'));
    assert.ok(!BUILTIN_PLUGIN_IDS.has('evil-plugin'));
  });
});
