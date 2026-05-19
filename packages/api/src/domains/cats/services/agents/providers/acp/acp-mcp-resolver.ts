/**
 * Resolves MCP server configs for ACP sessions.
 *
 * Built-in cat-cafe* servers: auto-generated from projectRoot (zero config).
 * External servers (pencil, etc.): read from capabilities.json (#712).
 * User project servers: merged from userProjectRoot/.mcp.json (F145 Phase E).
 *
 * F145 Phase C: community users can clone + pnpm install without hand-writing .mcp.json.
 * F145 Phase E: community users' own project MCP servers auto-merge into ACP sessions.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolvePencilCommand,
} from '../../../../../../config/capabilities/capability-orchestrator.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

const log = createModuleLogger('acp-mcp-resolver');

// ─── Built-in Clowder AI MCP auto-provision ────────────────────────

const MCP_SERVER_DIST = 'packages/mcp-server/dist';

/** Returns the dist entrypoint filename for a canonical builtin, or null. */
function builtinEntrypoint(name: string): string | null {
  return CAT_CAFE_SPLIT_ENTRYPOINTS.get(name) ?? null;
}

/**
 * Auto-generate an AcpMcpServerStdio for a built-in cat-cafe server.
 * Returns null for non-builtin names.
 */
export function resolveBuiltinCatCafeServer(projectRoot: string, name: string): AcpMcpServerStdio | null {
  const entry = builtinEntrypoint(name);
  if (!entry) return null;
  return {
    name,
    command: 'node',
    args: [resolve(projectRoot, MCP_SERVER_DIST, entry)],
    env: [],
  };
}

// ─── capabilities.json reader for external servers (#712) ────────

function readCapabilitiesConfigSync(projectRoot: string): CapabilitiesConfig | null {
  try {
    const raw = readFileSync(join(projectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
    const data = JSON.parse(raw) as CapabilitiesConfig;
    if (data.version !== 1 || !Array.isArray(data.capabilities)) return null;
    return data;
  } catch {
    return null;
  }
}

function capabilityEntryToAcpMcpServer(
  name: string,
  mcpServer: NonNullable<CapabilityEntry['mcpServer']>,
): AcpMcpServer | null {
  if (mcpServer.transport === 'streamableHttp' && mcpServer.url) {
    return {
      type: 'http' as const,
      name,
      url: mcpServer.url,
      headers: mcpServer.headers ? Object.entries(mcpServer.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (mcpServer.command) {
    return {
      name,
      command: mcpServer.command,
      args: mcpServer.args ?? [],
      env: mcpServer.env ? Object.entries(mcpServer.env).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  log.warn({ name }, 'Capability entry has no usable transport — skipping');
  return null;
}

// ─── .mcp.json parsing — user project servers only ──────────────

interface McpJsonEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Convert a .mcp.json entry to the correct AcpMcpServer variant, or null if invalid. */
function toAcpMcpServer(name: string, entry: McpJsonEntry): AcpMcpServer | null {
  const isHttp = entry.type === 'http' || entry.type === 'streamableHttp';
  const isSse = entry.type === 'sse';

  if (isHttp && entry.url) {
    return {
      type: 'http' as const,
      name,
      url: entry.url,
      headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (isSse && entry.url) {
    return {
      type: 'sse' as const,
      name,
      url: entry.url,
      headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (entry.command) {
    return {
      name,
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ? Object.entries(entry.env).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  // No valid transport — skip
  log.warn({ name }, 'MCP server entry has no command and no url — skipping');
  return null;
}

function readMcpJson(mcpJsonPath: string): Record<string, McpJsonEntry> {
  let raw: { mcpServers?: Record<string, McpJsonEntry> };
  try {
    raw = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as typeof raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn({ path: mcpJsonPath }, '.mcp.json not found — external MCP servers will be unavailable');
      return {};
    }
    throw new Error(
      `Cannot read ${mcpJsonPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        'External MCP servers require .mcp.json with mcpServers entries.',
    );
  }
  return raw.mcpServers ?? {};
}

// ─── Main resolver ───────────────────────────────────────────────

/**
 * Resolve MCP servers for an ACP session.
 *
 * Three-layer priority (F145 Phase E):
 *   1. Built-in cat-cafe* — auto-generated from projectRoot (highest)
 *   2. Whitelist externals — from projectRoot/.cat-cafe/capabilities.json (#712)
 *   3. User project servers — from userProjectRoot/.mcp.json (lowest, additive)
 *
 * @param projectRoot — monorepo root
 * @param whitelist — server names from cat-config.json mcpWhitelist
 * @param userProjectRoot — user's project directory (reads .mcp.json, merges all servers)
 * @returns AcpMcpServer[] ready for newSession()
 * @throws when whitelist is non-empty but zero servers could be resolved
 */
export async function resolveAcpMcpServers(
  projectRoot: string,
  whitelist: string[],
  userProjectRoot?: string,
  opts?: { disabledServerIds?: ReadonlySet<string> },
): Promise<AcpMcpServer[]> {
  if (!whitelist.length && !userProjectRoot) return [];

  // Expand legacy monolith "cat-cafe" to split server IDs so old catalogs
  // resolve to builtins instead of falling through to .mcp.json lookup.
  const expanded = new Set<string>();
  for (const name of whitelist) {
    if (name === 'cat-cafe') {
      for (const splitId of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) expanded.add(splitId);
    } else {
      expanded.add(name);
    }
  }

  const disabled = opts?.disabledServerIds;
  const servers: AcpMcpServer[] = [];
  const externalNames: string[] = [];

  // Phase 1: resolve builtins from projectRoot (no .mcp.json needed)
  for (const name of expanded) {
    if (disabled?.has(name)) {
      log.info({ name }, 'Skipping disabled server (capabilities.json)');
      continue;
    }
    const builtin = resolveBuiltinCatCafeServer(projectRoot, name);
    if (builtin) {
      servers.push(builtin);
    } else {
      externalNames.push(name);
    }
  }

  // Phase 2: resolve externals from capabilities.json (#712)
  const missing: string[] = [];
  if (externalNames.length > 0) {
    const capConfig = readCapabilitiesConfigSync(projectRoot);
    if (capConfig) {
      for (const name of externalNames) {
        const cap = capConfig.capabilities.find((c) => c.type === 'mcp' && c.id === name);
        if (!cap?.mcpServer) {
          missing.push(name);
          continue;
        }
        if (cap.mcpServer.resolver === 'pencil') {
          const resolved = await resolvePencilCommand({ projectRoot });
          if (resolved) {
            servers.push({ name, command: resolved.command, args: resolved.args, env: [] });
          } else {
            missing.push(name);
            log.warn({ name }, 'Pencil resolver found no installation — server unavailable');
          }
          continue;
        }
        const server = capabilityEntryToAcpMcpServer(name, cap.mcpServer);
        if (server) servers.push(server);
        else missing.push(name);
      }
    } else {
      missing.push(...externalNames);
      log.warn('capabilities.json not found — external MCP servers unavailable');
    }
  }

  if (missing.length > 0) {
    log.error(
      { missing, resolved: servers.map((s) => s.name) },
      'MCP whitelist entries not found in capabilities.json — these servers will NOT be available to ACP agent',
    );
  }

  const disabledFromWhitelist = disabled ? [...expanded].filter((n) => disabled.has(n)).length : 0;
  if (whitelist.length > 0 && servers.length === 0 && (disabledFromWhitelist === 0 || missing.length > 0)) {
    throw new Error(
      `All ${whitelist.length} MCP whitelist entries [${whitelist.join(', ')}] are missing. ` +
        `Active missing: [${missing.join(', ')}], disabled: ${disabledFromWhitelist}. ` +
        'ACP agent would start with zero MCP servers — aborting to prevent silent tool-call stalls.',
    );
  }

  // Phase 3 (F145 Phase E): merge user project .mcp.json servers
  if (userProjectRoot) {
    const resolvedNames = new Set(servers.map((s) => s.name));
    const userMcpJsonPath = join(userProjectRoot, '.mcp.json');
    const userServers = readMcpJson(userMcpJsonPath);

    for (const [name, entry] of Object.entries(userServers)) {
      if (resolvedNames.has(name)) {
        log.debug({ name }, 'User project server shadowed by higher-priority server');
        continue;
      }
      const server = toAcpMcpServer(name, entry);
      if (server) servers.push(server);
    }
  }

  log.info(
    { count: servers.length, names: servers.map((s) => s.name), missing, hasUserProject: !!userProjectRoot },
    'Resolved MCP servers for ACP',
  );
  return servers;
}

// ─── Per-invoke user project MCP resolution (F145 Phase E) ──────

/**
 * Resolve MCP servers from a user project's .mcp.json for per-invoke merge.
 *
 * Used by GeminiAcpAdapter.invoke() to add user project servers to
 * base servers already resolved at init time. Servers whose names
 * are in `exclude` are skipped (higher-priority layer wins).
 *
 * Returns [] if .mcp.json is missing or has no mcpServers key.
 */
export function resolveUserProjectMcpServers(userProjectRoot: string, exclude: ReadonlySet<string>): AcpMcpServer[] {
  const mcpJsonPath = join(userProjectRoot, '.mcp.json');
  const entries = readMcpJson(mcpJsonPath);
  const servers: AcpMcpServer[] = [];

  for (const [name, entry] of Object.entries(entries)) {
    if (exclude.has(name)) {
      log.debug({ name, userProjectRoot }, 'User project server shadowed by base server');
      continue;
    }
    const server = toAcpMcpServer(name, entry);
    if (server) servers.push(server);
  }

  if (servers.length > 0) {
    log.info(
      { userProjectRoot, count: servers.length, names: servers.map((s) => s.name) },
      'F145-E: resolved user project MCP servers',
    );
  }
  return servers;
}
