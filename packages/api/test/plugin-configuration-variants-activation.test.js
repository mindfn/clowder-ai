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
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
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

function createRuntime(projectRoot) {
  const limbRegistry = new LimbRegistry();
  return {
    limbRegistry,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      contract: {
        manifestContractVersions: ['0.1.0', '0.2.0'],
        validateEffectiveGrants,
        validateManifest,
      },
      limbRegistry,
      taskRunner: fakeTaskRunner(),
      mcpConfigIO: {
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

async function writeFixturePackage() {
  const packageRoot = await tempRoot('cat-cafe-variants-feishu-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(feishuManifest())}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    'export default { create() { return { start() { return { actions: {}, stop() {} }; } }; } };\n',
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
