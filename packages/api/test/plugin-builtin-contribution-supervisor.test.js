import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BuiltinPluginContributionSupervisor,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

const digest = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;

function exactManifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.video-analysis',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Video Analysis',
    configuration: [
      { key: 'provider', label: 'Provider', kind: 'select', required: true },
      { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
      { key: 'baseUrl', label: 'Base URL', kind: 'url', required: false },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'video-analysis-toolset',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
        environment: {
          VIDEO_ANALYSIS_PROVIDER: { source: 'config', key: 'provider' },
          VIDEO_ANALYSIS_API_KEY: { source: 'secret', key: 'apiKey' },
          VIDEO_ANALYSIS_BASE_URL: { source: 'config', key: 'baseUrl' },
        },
      },
    ],
    features: [
      {
        id: 'analyze-video',
        name: 'Analyze video',
        resources: [],
        contributions: [{ type: 'mcp', id: 'video-analysis-toolset' }],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin' },
    ...overrides,
  };
}

function contract() {
  return {
    manifestContractVersions: ['0.1.0-beta.13'],
    validateManifest: (value) => ({ valid: true, manifest: value, errors: [] }),
    validateEffectiveGrants: (values) =>
      new Set(values).size === values.length &&
      values.every((value) => value === 'plugin.config.read' || value === 'secret.read'),
  };
}

async function harness({ manifest = exactManifest(), config = {}, secrets = {}, inventoryStore } = {}) {
  const exactContract = contract();
  const store = new MemoryPluginInventoryStore(undefined, { contract: exactContract });
  const inventory = new HostInventoryControlPlane(store, {
    contract: exactContract,
    createInstanceId: () => 'pi_video',
    now: () => 1_000,
  });
  await inventory.installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: manifest.pluginId,
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  });
  await store.transaction((transaction) => {
    const instance = transaction.instances.get('pi_video');
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
    });
  });
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-builtin-contribution-'));
  await mkdir(join(rootDir, 'dist'));
  await writeFile(join(rootDir, 'dist/mcp-entrypoint.js'), '// fixture\n');
  let releases = 0;
  const launches = [];
  let closes = 0;
  const supervisor = new BuiltinPluginContributionSupervisor({
    inventory: inventoryStore?.(store) ?? store,
    materializer: {
      resolve: async () => ({
        rootDir,
        verifyIntegrity: async () => {},
        release: async () => {
          releases += 1;
        },
      }),
    },
    configuration: {
      readConfig: async (_instanceId, key) => config[key],
      readSecret: async (_instanceId, key) => secrets[key],
    },
    runtime: {
      start: async (spec) => {
        launches.push(structuredClone(spec));
        return {
          tools: [
            {
              name: 'video_analysis',
              description: 'Analyze a remote video.',
              inputSchema: {
                type: 'object',
                properties: { videoUrl: { type: 'string' } },
                required: ['videoUrl'],
              },
            },
          ],
          callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }),
          close: async () => {
            closes += 1;
          },
        };
      },
    },
    now: () => 2_000,
  });
  return {
    rootDir: await realpath(rootDir),
    inventory,
    store,
    supervisor,
    launches,
    closes: () => closes,
    releases: () => releases,
  };
}

test('activates a typed MCP contribution with Host config/secret bindings and revokes it on stop', async () => {
  const h = await harness({
    config: { provider: 'gemini', baseUrl: 'http://127.0.0.1:12345' },
    secrets: { apiKey: 'isolated-secret' },
  });

  await h.supervisor.start('pi_video');

  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0], {
    pluginInstanceId: 'pi_video',
    pluginId: 'dev.clowder.video-analysis',
    contributionId: 'video-analysis-toolset',
    command: process.execPath,
    args: [join(h.rootDir, 'dist/mcp-entrypoint.js')],
    cwd: h.rootDir,
    env: {
      VIDEO_ANALYSIS_PROVIDER: 'gemini',
      VIDEO_ANALYSIS_API_KEY: 'isolated-secret',
      VIDEO_ANALYSIS_BASE_URL: 'http://127.0.0.1:12345',
    },
  });
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'healthy');
  assert.equal(JSON.stringify(await h.store.snapshot()).includes('isolated-secret'), false);
  assert.deepEqual(await h.supervisor.listPluginTools('dev.clowder.video-analysis'), [
    {
      contributionId: 'video-analysis-toolset',
      name: 'video_analysis',
      description: 'Analyze a remote video.',
      inputSchema: {
        type: 'object',
        properties: { videoUrl: { type: 'string' } },
        required: ['videoUrl'],
      },
    },
  ]);
  assert.deepEqual(
    await h.supervisor.callPluginTool('dev.clowder.video-analysis', 'video-analysis-toolset', 'video_analysis', {
      videoUrl: 'https://media.example/video.mp4',
      prompt: 'summarize',
    }),
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: 'video_analysis',
            args: { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
          }),
        },
      ],
    },
  );

  await h.supervisor.stop('pi_video', 'owner_disabled');

  assert.equal(h.closes(), 1);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
  await assert.rejects(h.supervisor.listPluginTools('dev.clowder.video-analysis'), /is not active/);
});

test('rechecks the grant fence before every tool call and tears down stale authority', async () => {
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
  });
  await h.supervisor.start('pi_video');
  await h.inventory.revokeGrant({
    pluginInstanceId: 'pi_video',
    capability: 'secret.read',
    expectedGrantRevision: 1,
  });

  await assert.rejects(
    h.supervisor.callPluginTool('dev.clowder.video-analysis', 'video-analysis-toolset', 'video_analysis', {}),
    /lost live contribution authority/,
  );

  assert.equal(h.closes(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('missing required secret fails before capability publication and leaves runtime stopped', async () => {
  const h = await harness({ config: { provider: 'gemini' } });

  await assert.rejects(h.supervisor.start('pi_video'), /required secret apiKey is unavailable/);

  assert.deepEqual(h.launches, []);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('rejects a contribution entrypoint that resolves outside its materialized package', async () => {
  const h = await harness({
    manifest: exactManifest({
      contributions: [
        {
          type: 'mcp',
          id: 'video-analysis-toolset',
          runtime: { transport: 'stdio', entrypoint: '../escape.js' },
          environment: {},
        },
      ],
    }),
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
  });

  await assert.rejects(h.supervisor.start('pi_video'), /entrypoint must resolve inside/);

  assert.deepEqual(h.launches, []);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('clears the active execution when the final healthy projection fails', async () => {
  let transactions = 0;
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
    inventoryStore: (store) => ({
      snapshot: () => store.snapshot(),
      transaction: (operation) => {
        transactions += 1;
        if (transactions === 2) throw new Error('fixture healthy projection failure');
        return store.transaction(operation);
      },
    }),
  });

  await assert.rejects(h.supervisor.start('pi_video'), /failed to start/);

  assert.equal(h.launches.length, 1, 'healthy projection must fail only after the runtime started');
  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);
  assert.equal(h.closes(), 1);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});
