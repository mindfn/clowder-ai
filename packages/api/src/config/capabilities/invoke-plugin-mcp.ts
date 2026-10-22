import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
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
  return servers.map((server) => {
    if (!connections.includes(server)) return server;
    const projectEntries = config.capabilities.filter((entry) => entry.id === server.capabilityId);
    const hostEntries = host?.capabilities.filter((entry) => entry.id === server.capabilityId) ?? [];
    const project = projectEntries[0];
    const current = hostEntries[0];
    if (
      host &&
      projectEntries.length === 1 &&
      hostEntries.length === 1 &&
      project?.pluginId &&
      current?.pluginId === project.pluginId &&
      project.source === current.source &&
      current.type === 'mcp' &&
      !project.mcpServerOverride &&
      !current.mcpServerOverride &&
      isDeepStrictEqual(transport(project), transport(current)) &&
      current.mcpServer?.env?.CLOWDER_PLUGIN_ACTION_TOKEN
    ) {
      // Never attach a Host credential to a project-selected executable or env
      // (including NODE_OPTIONS/PATH). Only project access policy survives.
      const trusted = resolveServersForCat({ ...host, capabilities: [current] }, catId)[0];
      if (trusted) return { ...trusted, enabled: server.enabled };
    }
    const env = { ...server.env };
    for (const key of CONNECTION_KEYS) delete env[key];
    return { ...server, enabled: false, env };
  });
}

function transport(entry: CapabilityEntry): Omit<NonNullable<CapabilityEntry['mcpServer']>, 'env'> | undefined {
  if (!entry.mcpServer) return undefined;
  const { env: _environment, ...definition } = entry.mcpServer;
  return definition;
}
