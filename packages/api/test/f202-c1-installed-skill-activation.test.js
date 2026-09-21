import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { readCapabilitiesConfig } from '../dist/config/capabilities/capability-orchestrator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

test('enabling a locally installed package registers its declared skill capability', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-installed-skill-project-');
  const packageRoot = await tempRoot('cat-cafe-f202-installed-skill-package-');
  const manifest = {
    pluginId: 'dev.clowder.local-skill-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Local Skill Fixture',
    contributions: [{ type: 'skill', id: 'local-skill', path: 'skills/local-skill' }],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'skill', id: 'local-skill' }],
        capabilities: [],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'skills/local-skill'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    'export default { create(hostManifest) { return { manifest: hostManifest }; } };\n',
    'utf8',
  );
  await writeFile(join(packageRoot, 'skills/local-skill/SKILL.md'), '# Local Skill\n', 'utf8');

  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });

  // The public Manager path delegates to LocalPluginPackageAdmission.install() and then
  // performs the readiness reconciliation required before lifecycle enablement.
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  assert.equal(beforeEnable.actions.setEnabled, true, 'the admitted package must be ready to enable');
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const enabledInstance = (await runtime.inventoryStore.snapshot()).instances.find(
    (instance) => instance.pluginInstanceId === installed.pluginInstanceId,
  );
  assert.equal(enabledInstance?.activationState, 'enabled');
  assert.equal(enabledInstance?.runtimeState, 'healthy');

  const capabilities = await readCapabilitiesConfig(projectRoot);
  assert.ok(
    capabilities?.capabilities.some(
      (capability) =>
        capability.type === 'skill' &&
        capability.id === 'local-skill' &&
        capability.pluginId === installed.pluginId &&
        capability.enabled === true,
    ),
    'a skill declared by an enabled installed package must be present in Host capabilities',
  );
});
