import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCapabilitiesConfig, resolveServersForCat } from '../dist/config/capabilities/capability-orchestrator.js';
import { readInvocationMcpConfig } from '../dist/config/capabilities/invoke-mcp-config.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';

test('a linked-worktree Host publishes an enabled plugin skill and MCP to another project', async (t) => {
  const f = await fixture(t, undefined);
  await f.mutate(true);

  const config = await readCapabilitiesConfig(f.capabilityProjectRoot);
  const skill = config.capabilities.find(
    (entry) => entry.type === 'skill' && entry.id === 'guide' && entry.pluginId === f.pluginId,
  );
  assert.equal(skill?.enabled, true);
  assert.ok(skill.skillsSource);
  await access(join(f.capabilityProjectRoot, '.codex/skills/guide/SKILL.md'));

  const bound = await readCapabilitiesConfig(f.boundProjectRoot);
  const boundSkill = bound.capabilities.find(
    (entry) => entry.type === 'skill' && entry.id === 'guide' && entry.pluginId === f.pluginId,
  );
  assert.equal(boundSkill?.enabled, true);
  await access(join(f.boundProjectRoot, '.codex/skills/guide/SKILL.md'));

  const capabilityId = `plugin:${f.pluginId}:native`;
  const invocation = readInvocationMcpConfig(f.capabilityProjectRoot, f.boundProjectRoot);
  const server = resolveServersForCat(invocation.config, 'codex', { accessScope: invocation.accessScope }).find(
    (entry) => entry.capabilityId === capabilityId,
  );
  assert.ok(server, 'a conversation bound to another project must receive the plugin MCP');
  assert.equal(server.enabled, true);
  assert.equal(server.workingDir.startsWith(f.projectRoot), true);

  const launch = await f.runtime.supervisor.resolveNativeMcpLaunch({
    mode: 'plugin_native',
    pluginInstanceId: f.installed.pluginInstanceId,
    contributionId: 'native',
  });
  assert.ok(launch.workingDirectory.startsWith(f.projectRoot));
  await access(launch.args[0]);

  await f.mutate(false);
  const afterDisable = await readCapabilitiesConfig(f.boundProjectRoot);
  assert.equal(
    afterDisable.capabilities.some((entry) => entry.pluginId === f.pluginId),
    false,
    'disable must remove both plugin capabilities from the bound project',
  );
});
