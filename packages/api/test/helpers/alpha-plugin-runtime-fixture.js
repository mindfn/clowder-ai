import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../../dist/domains/plugin/index.js';
import { syncMcpAll } from '../../dist/mcp/mcp-sync-all.js';

export async function fixture(t, deployment, withRuntimeRoot = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-alpha-publication-')));
  let runtime;
  t.after(async () => {
    try {
      await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const projectRoot = join(root, 'deployment');
  const capabilityProjectRoot = join(root, 'persistent');
  const boundProjectRoot = join(root, 'bound-project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, '.git'), 'gitdir: ../persistent/.git/worktrees/deployment\n');
  await mkdir(join(capabilityProjectRoot, 'cat-cafe-skills'), { recursive: true });
  await writeCapabilitiesConfig(boundProjectRoot, { version: 2, capabilities: [] });
  const packageRoot = join(root, 'package');
  const pluginId = 'dev.clowder.alpha-publication';
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Alpha publication fixture',
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [
          { type: 'mcp', id: 'native' },
          { type: 'skill', id: 'guide' },
        ],
      },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'native',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
      },
      { type: 'skill', id: 'guide', path: 'skills/guide' },
    ],
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'skills/guide'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(packageRoot, 'dist/mcp.js'), 'process.exit(0);\n');
  await writeFile(join(packageRoot, 'skills/guide/SKILL.md'), '# Guide\n');
  await writeCapabilitiesConfig(capabilityProjectRoot, {
    version: 2,
    capabilities: [
      { id: 'unrelated', type: 'mcp', source: 'external', enabled: false, mcpServer: { command: 'unrelated' } },
    ],
  });
  await writeFile(
    join(capabilityProjectRoot, '.cat-cafe/governance-registry.json'),
    JSON.stringify({ entries: [{ projectPath: boundProjectRoot }] }),
  );
  let writes = 0;
  const previousDeployment = process.env.CAT_CAFE_DEPLOYMENT_ID;
  const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
  if (withRuntimeRoot) process.env.CAT_CAFE_RUNTIME_ROOT = projectRoot;
  else delete process.env.CAT_CAFE_RUNTIME_ROOT;
  if (deployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
  else process.env.CAT_CAFE_DEPLOYMENT_ID = deployment;
  try {
    runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      binaryProjectRoot: projectRoot,
      capabilityProjectRoot,
      messageStore: {},
      contract: { manifestContractRange: '0.1.0', validateManifest },
      mcpConfigIO: {
        readConfig: () => readCapabilitiesConfig(capabilityProjectRoot),
        withLock: (operation) => withCapabilityLock(capabilityProjectRoot, operation),
        writeAndRegenCli: async (config) => {
          writes++;
          await writeCapabilitiesConfig(capabilityProjectRoot, config);
        },
        syncProjects: () => syncMcpAll(capabilityProjectRoot),
      },
    });
  } finally {
    if (previousDeployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
    else process.env.CAT_CAFE_DEPLOYMENT_ID = previousDeployment;
    if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
  }
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const mutate = async (enabled) => {
    const current = (await composition.manager.get(pluginId)).plugin;
    return composition.manager.setEnabled(pluginId, { enabled, expectedRevision: current.lifecycleRevision });
  };
  return {
    runtime,
    composition,
    installed,
    pluginId,
    projectRoot,
    capabilityProjectRoot,
    boundProjectRoot,
    mutate,
    writes: () => writes,
  };
}
