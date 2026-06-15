/**
 * IM Connector Loader — F231
 *
 * Discovers and loads both built-in and external IM connector plugins.
 * Built-in connectors are statically imported from `im-connectors/`.
 * External connectors are dynamically imported from npm packages listed
 * in the `IM_CONNECTOR_PLUGINS` environment variable.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { IMConnectorPlugin } from './im-connector-plugin.js';

/**
 * Load all built-in IM connector plugins.
 * Static imports ensure tree-shaking and compile-time type checking.
 */
export async function loadBuiltinConnectors(): Promise<IMConnectorPlugin[]> {
  const modules = await Promise.all([
    import('./im-connectors/feishu/index.js'),
    import('./im-connectors/telegram/index.js'),
    import('./im-connectors/dingtalk/index.js'),
    import('./im-connectors/xiaoyi/index.js'),
    import('./im-connectors/wecom-bot/index.js'),
    import('./im-connectors/wecom-agent/index.js'),
    import('./im-connectors/weixin/index.js'),
  ]);
  return modules.map((m) => m.default);
}

/**
 * Load external IM connector plugins from npm packages.
 * Package names come from `IM_CONNECTOR_PLUGINS` env var (comma-separated).
 * Exported for use by connector-gateway-bootstrap (external plugins only).
 */
export async function loadExternalConnectors(
  envValue: string | undefined,
  log: FastifyBaseLogger,
): Promise<IMConnectorPlugin[]> {
  if (!envValue?.trim()) return [];

  const packageNames = envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const results: IMConnectorPlugin[] = [];

  for (const name of packageNames) {
    try {
      const mod = await import(name);
      const plugin: IMConnectorPlugin = mod.default ?? mod;

      // Validate minimal interface contract
      if (!plugin.id || typeof plugin.id !== 'string') {
        log.warn({ package: name }, '[IMConnectorLoader] Plugin missing `id` — skipped');
        continue;
      }
      if (!plugin.definition || typeof plugin.definition !== 'object') {
        log.warn({ package: name, id: plugin.id }, '[IMConnectorLoader] Plugin missing `definition` — skipped');
        continue;
      }
      if (typeof plugin.createAdapter !== 'function') {
        log.warn({ package: name, id: plugin.id }, '[IMConnectorLoader] Plugin missing `createAdapter()` — skipped');
        continue;
      }
      if (typeof plugin.isConfigured !== 'function') {
        log.warn({ package: name, id: plugin.id }, '[IMConnectorLoader] Plugin missing `isConfigured()` — skipped');
        continue;
      }

      results.push(plugin);
      log.info({ id: plugin.id, package: name }, '[IMConnectorLoader] External connector loaded');
    } catch (err) {
      log.warn({ err, package: name }, '[IMConnectorLoader] Failed to load external connector');
    }
  }

  return results;
}

/**
 * Load all IM connector plugins (built-in + external).
 * External IDs that conflict with built-in IDs are rejected.
 */
export async function loadAllIMConnectors(log: FastifyBaseLogger): Promise<IMConnectorPlugin[]> {
  const builtins = await loadBuiltinConnectors();
  const externals = await loadExternalConnectors(process.env.IM_CONNECTOR_PLUGINS, log);

  const builtinIds = new Set(builtins.map((c) => c.id));
  const validExternals: IMConnectorPlugin[] = [];

  for (const ext of externals) {
    if (builtinIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[IMConnectorLoader] External connector ID conflicts with built-in — skipped');
      continue;
    }
    validExternals.push(ext);
  }

  const all = [...builtins, ...validExternals];
  log.info(
    { builtin: builtins.length, external: validExternals.length, total: all.length },
    '[IMConnectorLoader] All IM connectors loaded',
  );
  return all;
}
