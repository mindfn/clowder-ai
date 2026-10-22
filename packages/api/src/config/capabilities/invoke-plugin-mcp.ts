import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import { resolveServersForCat } from './capability-orchestrator.js';

const CONNECTION_KEYS = ['CLOWDER_PLUGIN_ACTION_TOKEN', 'CLOWDER_PLUGIN_ACTION_PATH'] as const;

/** Project files own access policy; a Host activation owns its connection credentials. */
export function resolveInvocationMcpServers(
  config: CapabilitiesConfig,
  catId: string,
  options: { accessScope: 'global' | 'project'; capabilitiesProjectRoot: string },
): ReturnType<typeof resolveServersForCat> {
  const servers = resolveServersForCat(config, catId, options);
  if (options.accessScope !== 'project') return servers;
  const connections = servers.filter((server) => server.source === 'plugin' && server.env?.CLOWDER_PLUGIN_ACTION_TOKEN);
  if (connections.length === 0) return servers;
  let host: CapabilitiesConfig | undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(join(options.capabilitiesProjectRoot, '.cat-cafe/capabilities.json'), 'utf8'),
    );
    if ((parsed?.version === 1 || parsed?.version === 2) && Array.isArray(parsed.capabilities)) host = parsed;
  } catch {
    // An unavailable Host registry cannot authorize a cached project connection.
  }
  for (const server of connections) {
    const projectEntry = config.capabilities.find((entry) => entry.id === server.capabilityId);
    const current = host?.capabilities.find(
      (entry) => entry.type === 'mcp' && entry.id === server.capabilityId && entry.pluginId === projectEntry?.pluginId,
    );
    const environment = current?.mcpServer?.env;
    const env = { ...server.env };
    for (const key of CONNECTION_KEYS) {
      delete env[key];
      if (environment?.[key]) env[key] = environment[key];
    }
    server.env = env;
    if (!env.CLOWDER_PLUGIN_ACTION_TOKEN) server.enabled = false;
  }
  return servers;
}
