import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MachineOfficialPluginCatalog, OfficialPluginManagerCatalogAdapter } from '../dist/domains/plugin/index.js';

const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function rawCatalog() {
  return {
    schemaVersion: '1',
    plugins: [
      {
        pluginId: 'dev.clowder.video-analysis',
        name: 'Video Analysis',
        description: {
          default: 'Analyze remote videos.',
          translations: { 'zh-CN': '分析远程视频。' },
        },
        icon: { type: 'svg', src: 'assets/icon.svg' },
        publisher: { id: 'clowder-ai', name: 'Clowder AI' },
        keywords: ['analysis', 'video'],
        versions: [
          {
            version: '0.1.0-alpha.0',
            contractVersion: '0.1.0-beta.13',
            manifestPath: 'plugin.yaml',
            artifact: {
              kind: 'npm',
              packageName: '@clowder-ai/video-analysis',
              version: '0.1.0-alpha.0',
              tarballUrl: 'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.0.tgz',
              integrity: digest,
              shasum: '0'.repeat(40),
              provenance: {
                repository: 'https://github.com/zts212653/clowder-ai-plugins',
                sourceDirectory: 'packages/video-analysis',
              },
            },
          },
        ],
      },
    ],
  };
}

function canonicalValidator(value) {
  return { valid: true, catalog: value, errors: [] };
}

test('projects canonical machine catalog release truth while Host policy remains authoritative', async () => {
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: canonicalValidator,
    hostPolicies: [
      {
        pluginId: 'dev.clowder.video-analysis',
        effectiveGrants: ['events.publish'],
      },
    ],
    now: () => 1_000,
  });

  const snapshot = await provider.snapshot();
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.checkedAt, 1_000);
  assert.deepEqual(snapshot.entries, [
    {
      catalogId: 'dev.clowder.video-analysis',
      pluginId: 'dev.clowder.video-analysis',
      packageName: '@clowder-ai/video-analysis',
      version: '0.1.0-alpha.0',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.0.tgz',
      packageDigest: digest,
      effectiveGrants: ['events.publish'],
      presentation: {
        displayName: 'Video Analysis',
        description: {
          default: 'Analyze remote videos.',
          translations: { 'zh-CN': '分析远程视频。' },
        },
        icon: { type: 'svg', src: 'assets/icon.svg' },
        publisher: 'Clowder AI',
      },
    },
  ]);

  const managerCatalog = await new OfficialPluginManagerCatalogAdapter(provider, []).snapshot();
  assert.equal(managerCatalog.status, 'fresh');
  assert.deepEqual(managerCatalog.candidates[0], {
    catalogId: 'dev.clowder.video-analysis',
    pluginId: 'dev.clowder.video-analysis',
    packageName: '@clowder-ai/video-analysis',
    version: '0.1.0-alpha.0',
    packageDigest: digest,
    displayName: 'Video Analysis',
    description: {
      default: 'Analyze remote videos.',
      translations: { 'zh-CN': '分析远程视频。' },
    },
    icon: { type: 'svg', src: 'assets/icon.svg' },
    publisher: 'Clowder AI',
    ownerAuthRequired: false,
    capabilities: [],
  });
});

test('fails closed when catalog validation or Host admission policy is missing', async () => {
  const invalid = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: () => ({ valid: false, errors: [{ message: 'invalid' }] }),
    hostPolicies: [],
    now: () => 2_000,
  });
  assert.deepEqual(await invalid.snapshot(), {
    entries: [],
    status: 'degraded',
    checkedAt: 2_000,
    errorCode: 'CATALOG_CONTRACT_INVALID',
  });

  const missingPolicy = new MachineOfficialPluginCatalog({
    loadCatalog: async () => rawCatalog(),
    validateCatalog: canonicalValidator,
    hostPolicies: [],
    now: () => 3_000,
  });
  assert.deepEqual(await missingPolicy.snapshot(), {
    entries: [],
    status: 'degraded',
    checkedAt: 3_000,
    errorCode: 'CATALOG_POLICY_MISSING',
  });
});

test('retains the last canonical machine catalog when a later read fails', async () => {
  let fail = false;
  let now = 4_000;
  const provider = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      if (fail) throw new Error('private upstream detail');
      return rawCatalog();
    },
    validateCatalog: canonicalValidator,
    hostPolicies: [
      {
        pluginId: 'dev.clowder.video-analysis',
        effectiveGrants: [],
      },
    ],
    now: () => now,
  });

  assert.equal((await provider.snapshot()).status, 'fresh');
  fail = true;
  now = 5_000;
  const degraded = await provider.snapshot();
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.errorCode, 'CATALOG_FETCH_FAILED');
  assert.equal(degraded.checkedAt, 5_000);
  assert.equal(degraded.entries[0].pluginId, 'dev.clowder.video-analysis');
  assert.equal(JSON.stringify(degraded).includes('private upstream detail'), false);
});
