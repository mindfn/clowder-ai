import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { reconcileOfficialPluginGrants } from '../dist/domains/plugin/manager/official-plugin-grants.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';

// The narrowed GitHub package requests this one feature. Native action credentials require
// the whole feature, so an installation can appear healthy while exposing unusable MCP tools.
const requested = [
  'schedule.register',
  'plugin.config.read',
  'secret.read',
  'plugin.state.get',
  'plugin.state.set',
  'task.read',
  'task.write',
  'thread.listMetadata',
  'thread.write',
  'messaging.send',
];
const previous = requested.filter((grant) => !['task.read', 'task.write'].includes(grant));
const manifest = (capabilities = requested) => ({
  pluginId: 'official.github-operations',
  name: 'GitHub tracking policy fixture',
  version: '0.1.0-alpha.18',
  contractVersion: '0.1.0',
  features: [
    {
      id: 'github-collaboration',
      name: 'GitHub collaboration operations',
      resources: [],
      capabilities,
      contributions: [{ type: 'mcp', id: 'github-tracking' }],
    },
  ],
  contributions: [
    {
      type: 'mcp',
      id: 'github-tracking',
      runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
      actions: [{ method: 'github.typed-wait.register-issue' }],
    },
  ],
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' },
});

function nativeActions(packageManifest, effectiveGrants) {
  const admission = {
    instance: {
      pluginInstanceId: 'github-instance',
      packageDigest: 'test-digest',
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: { manifest: packageManifest },
    effectiveGrants,
  };
  const actions = new NativePluginActions(async () => admission);
  actions.activate(admission, 0, async (method) => method);
  return actions;
}

test('local GitHub admission produces a callable native tracking connection with the real Host policy', async () => {
  const current = manifest();
  const grants = resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, current);
  const actions = nativeActions(current, grants);
  const env = actions.environment('github-instance', 'github-tracking');
  assert.ok(env.CLOWDER_PLUGIN_ACTION_TOKEN, 'tracking credentials must be issued for the shipped feature');
  assert.equal(env.CLOWDER_PLUGIN_ACTION_PATH, '/api/plugin-runtime/action');
  assert.equal(
    await actions.call(
      env.CLOWDER_PLUGIN_ACTION_TOKEN,
      'github.typed-wait.register-issue',
      {},
      {
        catId: 'cat',
        threadId: 'thread',
        userId: 'owner',
        invocationId: 'invocation',
        assertCurrent: async () => {},
      },
    ),
    'github.typed-wait.register-issue',
  );
  actions.deactivateAll();
});

test('startup repairs an existing eight-grant GitHub install without reinstalling its package', async () => {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'github-instance', now: () => 1 });
  const digest = `sha512-${createHash('sha512').update('github-tracking-grants').digest('base64')}`;
  await inventory.installPackage({
    manifest: manifest(),
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: 'official.github-operations',
    effectiveGrants: previous,
  });
  const before = await store.snapshot();
  assert.deepEqual(nativeActions(manifest(), previous).environment('github-instance', 'github-tracking'), {});
  const changes = await reconcileOfficialPluginGrants({
    store,
    inventory,
    hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES,
  });
  assert.deepEqual(changes, [
    {
      pluginId: 'official.github-operations',
      pluginInstanceId: 'github-instance',
      added: ['task.read', 'task.write'],
      removed: [],
    },
  ]);
  const after = await store.snapshot();
  assert.deepEqual(after.packages, before.packages);
  assert.deepEqual(after.instances, before.instances);
  const actions = nativeActions(manifest(), after.grants[0].effectiveGrants);
  assert.ok(actions.environment('github-instance', 'github-tracking').CLOWDER_PLUGIN_ACTION_TOKEN);
  actions.deactivateAll();
  assert.deepEqual(
    await reconcileOfficialPluginGrants({ store, inventory, hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES }),
    [],
  );
});

test('GitHub policy does not grant undeclared access or allow packages to widen its upper bound', () => {
  assert.deepEqual(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest([])), []);
  assert.deepEqual(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest(['plugin.config.read'])), [
    'plugin.config.read',
  ]);
  const grants = resolveLocalPluginEffectiveGrants(
    OFFICIAL_PLUGIN_HOST_POLICIES,
    manifest([...requested, 'task.admitEntrusted', 'streams.read', 'thread.readContent']),
  );
  assert.deepEqual([...grants].sort(), [...requested].sort());
  assert.deepEqual(
    nativeActions(manifest([...requested, 'streams.read']), grants).environment('github-instance', 'github-tracking'),
    {},
  );
});
