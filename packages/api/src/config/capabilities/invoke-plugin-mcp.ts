import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import type { NativeMcpServer } from '../../domains/plugin/declared/native-mcp-types.js';
import { resolveServersForCat } from './capability-orchestrator.js';
import { isSameCapabilityRoot } from './invoke-capability-root.js';

const sources = new Map<string, (capabilityId: string) => NativeMcpServer | undefined>();
const CONNECTION_KEYS = ['CLOWDER_PLUGIN_ACTION_TOKEN', 'CLOWDER_PLUGIN_ACTION_PATH'] as const;

/** Bind a Host-owned runtime port, not a second copy of its activation state. */
export function bindHostPluginMcpSource(root: string, source: (id: string) => NativeMcpServer | undefined): () => void {
  const key = resolve(root);
  sources.set(key, source);
  return () => {
    if (sources.get(key) === source) sources.delete(key);
  };
}

/** Project files own access policy; the current Host runtime owns plugin launches. */
export function resolveInvocationMcpServers(
  config: CapabilitiesConfig,
  catId: string,
  options: { accessScope: 'global' | 'project'; capabilitiesProjectRoot: string },
): ReturnType<typeof resolveServersForCat> {
  const source = [...sources].find(([root]) => isSameCapabilityRoot(root, options.capabilitiesProjectRoot))?.[1];
  return resolveServersForCat(config, catId, options).map((server) => {
    if (server.source !== 'plugin') return server;
    const entries = config.capabilities.filter((entry) => entry.id === server.capabilityId);
    const entry = entries[0];
    const current = source?.(server.capabilityId ?? '');
    if (
      entries.length === 1 &&
      entry?.pluginId &&
      entry.id.startsWith(`plugin:${entry.pluginId}:`) &&
      (entry.source === 'plugin' || entry.source === 'cat-cafe') &&
      !entry.mcpServerOverride &&
      current &&
      isDeepStrictEqual(transport(entry, current), transportOfLaunch(current))
    ) {
      return {
        name: current.name,
        capabilityId: entry.id,
        source: 'plugin',
        enabled: server.enabled,
        command: current.command,
        args: [...current.args],
        env: { ...current.env },
        workingDir: current.workingDirectory,
        transport: current.transport,
      };
    }
    const env = { ...server.env };
    for (const key of CONNECTION_KEYS) delete env[key];
    return { ...server, enabled: false, env };
  });
}

function transport(entry: CapabilityEntry, current: NativeMcpServer) {
  const s = entry.mcpServer;
  return (
    s && {
      command: s.command,
      args: s.args ?? [],
      workingDir: s.workingDir ?? current.workingDirectory,
      transport: s.transport ?? 'stdio',
      resolver: s.resolver,
      url: s.url,
      headers: s.headers,
    }
  );
}
function transportOfLaunch(s: NativeMcpServer) {
  return {
    command: s.command,
    args: [...s.args],
    workingDir: s.workingDirectory,
    transport: s.transport,
    resolver: undefined,
    url: undefined,
    headers: undefined,
  };
}
