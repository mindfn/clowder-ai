import { resolve } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import type { NativeMcpServer } from '../../domains/plugin/declared/native-mcp-types.js';
import { resolveServersForCat } from './capability-orchestrator.js';
import { isSameCapabilityRoot } from './invoke-capability-root.js';

const sources = new Map<string, (capabilityId: string) => NativeMcpServer | undefined>();

/** Bind a Host-owned runtime port, not a second copy of its activation state. */
export function bindHostPluginMcpSource(root: string, source: (id: string) => NativeMcpServer | undefined): () => void {
  const key = resolve(root);
  sources.set(key, source);
  return () => {
    if (sources.get(key) === source) sources.delete(key);
  };
}

/** Persisted plugin entries supply access policy only; launch bytes come from the live Host. */
export function resolveInvocationMcpServers(
  config: CapabilitiesConfig,
  catId: string,
  options: { accessScope: 'global' | 'project'; hostRoot: string },
): ReturnType<typeof resolveServersForCat> {
  const source = [...sources].find(([root]) => isSameCapabilityRoot(root, options.hostRoot))?.[1];
  const refused = new Set<string>();
  const projected: CapabilitiesConfig = {
    ...config,
    capabilities: config.capabilities.map((entry) => {
      if (entry.type !== 'mcp' || (!entry.pluginId && entry.source !== 'plugin')) return entry;
      const current = source?.(entry.id);
      const permitted =
        config.capabilities.filter((candidate) => candidate.id === entry.id).length === 1 &&
        entry.pluginId &&
        entry.id.startsWith(`plugin:${entry.pluginId}:`) &&
        (entry.source === 'plugin' || entry.source === 'cat-cafe') &&
        !entry.mcpServerOverride &&
        current;
      if (!permitted || !current) {
        refused.add(entry.id);
        return { ...entry, mcpServerOverride: undefined, mcpServer: { command: 'echo', args: ['disabled-shim'] } };
      }
      // Do not read the persisted command/env, including legacy activation tokens.
      // This snapshot was materialized and verified by the active Host runtime.
      return {
        ...entry,
        mcpServerOverride: undefined,
        mcpServer: {
          command: current.command,
          args: [...current.args],
          env: { ...current.env },
          workingDir: current.workingDirectory,
          transport: current.transport,
        },
      };
    }),
  };
  return resolveServersForCat(projected, catId, options).map((server) =>
    refused.has(server.capabilityId ?? '') ? { ...server, enabled: false } : server,
  );
}
