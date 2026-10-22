/**
 * configurationVariants (contract 0.2.0) — end-to-end activation acceptance (design §3.4).
 *
 * WHY THIS EXISTS: the feishu plugin must receive its Verification Token (FEISHU_TOKEN) on the
 * declared MCP launch environment exactly when webhook mode is selected and a Token is stored,
 * and must fail closed when webhook mode is selected without one. These tests drive the real
 * install → configure → enable path against a feishu-shaped fixture package and read the actual
 * materialized MCP capability env, so no consumer can silently regress while unit tests stay green.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { fileBasedMcpIO } from '../dist/config/capabilities/capability-mcp-service.js';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { resolveProviderMcpConfig } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function fakeTaskRunner() {
  return {
    registerPostStart() {},
    unregister() {
      return true;
    },
  };
}

function createRuntime(projectRoot, mcpConfigIO) {
  const limbRegistry = new LimbRegistry();
  return {
    limbRegistry,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      contract: {
        manifestContractRange: '0.1.0 || 0.2.0',
        validateEffectiveGrants,
        validateManifest,
      },
      limbRegistry,
      taskRunner: fakeTaskRunner(),
      mcpConfigIO: mcpConfigIO ?? {
        readConfig: () => readCapabilitiesConfig(projectRoot),
        writeAndRegenCli: (config) => writeCapabilitiesConfig(projectRoot, config),
        withLock: (fn) => withCapabilityLock(projectRoot, fn),
      },
    }),
  };
}

/** The feishu-shaped target declaration (brief §47-64): Token required iff webhook. */
function feishuManifest() {
  return {
    pluginId: 'dev.clowder.feishu',
    version: '1.0.0',
    contractVersion: '0.2.0',
    name: 'Feishu',
    contributions: [
      {
        type: 'mcp',
        id: 'feishu-mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
        environment: { FEISHU_TOKEN: { source: 'secret', key: 'verificationToken' } },
      },
    ],
    features: [
      {
        id: 'messaging',
        name: 'Messaging',
        resources: [],
        contributions: [{ type: 'mcp', id: 'feishu-mcp' }],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    configuration: [
      {
        key: 'connectionMode',
        label: '连接模式',
        kind: 'select',
        required: true,
        default: 'websocket',
        options: [
          { value: 'websocket', label: '长连接' },
          { value: 'webhook', label: '回调' },
        ],
      },
      {
        key: 'verificationToken',
        label: 'Verification Token',
        kind: 'secret',
        required: true,
        requiredWhen: { key: 'connectionMode', value: 'webhook' },
      },
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
    ],
    configurationVariants: {
      discriminator: 'connectionMode',
      branches: [
        {
          id: 'webhook',
          when: { properties: { connectionMode: { const: 'webhook' } } },
          fields: ['verificationToken'],
        },
        {
          id: 'websocket',
          when: { properties: { connectionMode: { const: 'websocket' } } },
          fields: [],
        },
      ],
    },
  };
}

async function writeFixturePackage(nativeAction = false) {
  const packageRoot = await tempRoot('cat-cafe-variants-feishu-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const manifest = feishuManifest();
  if (nativeAction) manifest.contributions[0].actions = [{ method: 'native.run' }];
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    'export default { create() { return { start() { return { actions: { "native.run": async input => input }, stop() {} }; } }; } };\n',
    'utf8',
  );
  await writeFile(join(packageRoot, 'dist/mcp.js'), 'process.exit(0);\n', 'utf8');
  return packageRoot;
}

/** Install, configure, then enable — the real owner path. Returns the materialized MCP env. */
async function installConfigureEnable(updates) {
  const projectRoot = await tempRoot('cat-cafe-variants-feishu-project-');
  const packageRoot = await writeFixturePackage();
  const { runtime } = createRuntime(projectRoot);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]),
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeConfigure = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.configure(installed.pluginId, {
    expectedRevision: beforeConfigure.lifecycleRevision,
    updates,
  });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const capability = (await readCapabilitiesConfig(projectRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  return { capability, composition, installed };
}

test('websocket mode without a Token activates with no FEISHU_TOKEN on the MCP launch env', async () => {
  const { capability } = await installConfigureEnable([
    { key: 'connectionMode', value: 'websocket' },
    { key: 'appId', value: 'cli_1' },
  ]);
  assert.ok(capability?.mcpServer, 'the declared MCP must be installed as a Host capability');
  assert.equal('FEISHU_TOKEN' in (capability.mcpServer.env ?? {}), false);
});

test('webhook mode without the required Token refuses activation (fail-closed)', async () => {
  // The refusal may surface at either layer: the manager action gate
  // (§3.2 readiness: actions.setEnabled=false with `config-incomplete`) or the
  // lifecycle enable fence ('plugin configuration is not ready'). Both are
  // fail-closed; the exact wording is not the contract.
  await assert.rejects(
    installConfigureEnable([
      { key: 'connectionMode', value: 'webhook' },
      { key: 'appId', value: 'cli_1' },
    ]),
    /cannot change enabled state now|configuration is not ready|verificationToken is unavailable|configuration variant/,
  );
});

test('webhook mode with a Token delivers it to the actual MCP launch env', async () => {
  const { capability } = await installConfigureEnable([
    { key: 'connectionMode', value: 'webhook' },
    { key: 'verificationToken', value: 'tok_feishu' },
    { key: 'appId', value: 'cli_1' },
  ]);
  assert.ok(capability?.mcpServer, 'the declared MCP must be installed as a Host capability');
  assert.equal(capability.mcpServer.env?.FEISHU_TOKEN, 'tok_feishu');
});

test('variant changes refresh existing project MCP providers while preserving member and project blocks', async () => {
  const projectRoot = await tempRoot('variants-cascade-home-');
  const consumer = await tempRoot('variants-cascade-consumer-');
  const blockedProject = await tempRoot('variants-cascade-blocked-');
  for (const root of [projectRoot, consumer, blockedProject]) {
    await writeCapabilitiesConfig(root, { version: 2, capabilities: [] });
  }
  await writeFile(
    join(projectRoot, '.cat-cafe/governance-registry.json'),
    JSON.stringify({ entries: [consumer, blockedProject].map((projectPath) => ({ projectPath })) }),
  );
  const io = fileBasedMcpIO(projectRoot, {
    google: join(projectRoot, '.gemini/settings.json'),
    antigravity: join(projectRoot, '.test-antigravity/mcp.json'),
  });
  const { runtime } = createRuntime(projectRoot, io);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]),
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeFixturePackage(true) },
  });
  const configure = async (updates) => {
    const current = (await composition.manager.get(installed.pluginId)).plugin;
    await composition.manager.configure(installed.pluginId, { expectedRevision: current.lifecycleRevision, updates });
  };
  await configure([
    { key: 'connectionMode', value: 'websocket' },
    { key: 'verificationToken', value: 'fixture-variant-secret' },
    { key: 'appId', value: 'cli_fixture' },
  ]);
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const id = `plugin:${installed.pluginId}:feishu-mcp`;
  const name = id.replaceAll(':', '__');
  const entryAt = async (root) => (await readCapabilitiesConfig(root)).capabilities.find((entry) => entry.id === id);
  const initial = await entryAt(consumer);
  assert.ok(initial?.mcpServer, 'activation must reach an existing project automatically');
  assert.equal(Object.hasOwn(initial.mcpServer.env ?? {}, 'FEISHU_TOKEN'), false);
  const initialActionToken = initial.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(initialActionToken);
  const allCats = [...catRegistry.getAllIds()];
  const allowedCat = allCats.find((catId) => catId !== 'codex');
  assert.ok(allowedCat);
  await writeCapabilitiesConfig(consumer, {
    version: 2,
    capabilities: [{ ...initial, blockedCats: ['codex'] }],
  });
  await writeCapabilitiesConfig(blockedProject, {
    version: 2,
    capabilities: [{ ...initial, blockedCats: allCats }],
  });
  const inject = async (workingDirectory, catId) =>
    (
      await resolveProviderMcpConfig({
        callbackEnv: { CAT_CAFE_CAT_ID: catId },
        workingDirectory,
        mcpServerPath: join(projectRoot, 'packages/mcp-server/dist/index.js'),
        provider: 'codex',
      })
    )[name];
  try {
    // Configuring an enabled plugin refreshes its runtime in place.
    // Both branch transitions must update the existing project descriptor.
    for (const mode of ['webhook', 'websocket', 'webhook']) {
      await configure([{ key: 'connectionMode', value: mode }]);
      for (const root of [projectRoot, consumer, blockedProject]) {
        const entry = await entryAt(root);
        assert.ok(entry?.mcpServer, `${mode}: descriptor must still exist`);
        assert.equal(
          Object.hasOwn(entry.mcpServer.env ?? {}, 'FEISHU_TOKEN'),
          mode === 'webhook',
          `${mode}: ${root === projectRoot ? 'host' : root === consumer ? 'consumer' : 'blocked project'} descriptor`,
        );
      }
      const provider = await inject(consumer, allowedCat);
      assert.ok(provider, `${mode}: allowed member must receive the refreshed descriptor`);
      assert.equal(Object.hasOwn(provider.env ?? {}, 'FEISHU_TOKEN'), mode === 'webhook');
      const native = await runtime.supervisor.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: installed.pluginInstanceId,
        contributionId: 'feishu-mcp',
        actionMethods: ['native.run'],
      });
      assert.equal(Object.hasOwn(native.env, 'FEISHU_TOKEN'), mode === 'webhook');
      assert.ok(native.env.CLOWDER_PLUGIN_ACTION_TOKEN === initialActionToken, 'live refresh must not rotate tokens');
      assert.deepEqual(
        await runtime.supervisor.nativeActions.call(
          initialActionToken,
          'native.run',
          { mode },
          {
            userId: 'owner',
            catId: allowedCat,
            threadId: 'thread',
            invocationId: 'inv',
            assertCurrent: async () => {},
          },
        ),
        { mode },
      );
      assert.deepEqual((await entryAt(consumer)).blockedCats, ['codex']);
      assert.deepEqual((await entryAt(blockedProject)).blockedCats, allCats);
      assert.equal(await inject(consumer, 'codex'), undefined);
      assert.equal(await inject(blockedProject, allowedCat), undefined);
    }
    const fields = (await composition.manager.get(installed.pluginId)).plugin.configFields;
    assert.notEqual(fields.find((field) => field.key === 'verificationToken').currentValue, null);
  } finally {
    await runtime.supervisor.stopAll('test_complete');
  }
});
