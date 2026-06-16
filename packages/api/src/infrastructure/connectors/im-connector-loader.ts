/**
 * IM Connector Loader — F231
 *
 * Discovers and loads built-in, installed, and legacy external IM connector plugins.
 * - Built-in: statically imported from `im-connectors/`
 * - Installed: dynamically imported from `.cat-cafe/plugins/<id>/index.js` (Phase B)
 * - Legacy external: dynamically imported from npm packages via `IM_CONNECTOR_PLUGINS` env
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { IMConnectorPlugin } from './im-connector-plugin.js';
import { resolvePluginsDir } from './plugin-installer.js';

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

      if (!validatePluginInterface(plugin, name, log)) continue;

      results.push(plugin);
      log.info({ id: plugin.id, package: name }, '[IMConnectorLoader] External connector loaded');
    } catch (err) {
      log.warn({ err, package: name }, '[IMConnectorLoader] Failed to load external connector');
    }
  }

  return results;
}

/**
 * Load installed plugins from `.cat-cafe/plugins/` directory (Phase B).
 * Each subdirectory must contain `index.js` exporting an IMConnectorPlugin.
 */
export async function loadInstalledPlugins(projectRoot: string, log: FastifyBaseLogger): Promise<IMConnectorPlugin[]> {
  const pluginsDir = resolvePluginsDir(projectRoot);
  if (!existsSync(pluginsDir)) return [];

  const entries = readdirSync(pluginsDir).filter((e) => !e.startsWith('.'));
  const results: IMConnectorPlugin[] = [];

  for (const entry of entries) {
    const dir = join(pluginsDir, entry);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const entryPath = join(dir, 'index.js');
    if (!existsSync(entryPath)) {
      log.warn({ plugin: entry }, '[IMConnectorLoader] Plugin missing index.js — skipped');
      continue;
    }

    try {
      // Append cache-bust query to defeat ESM module cache after plugin update.
      // Without this, `import(fileURL)` returns the stale cached module for the same path.
      const fileUrl = pathToFileURL(entryPath);
      fileUrl.searchParams.set('v', String(Date.now()));
      const mod = await import(fileUrl.href);
      const plugin: IMConnectorPlugin = mod.default ?? mod;

      if (!validatePluginInterface(plugin, entry, log)) continue;

      results.push(plugin);
      log.info({ id: plugin.id, dir: entry }, '[IMConnectorLoader] Installed plugin loaded');
    } catch (err) {
      log.warn({ err, plugin: entry }, '[IMConnectorLoader] Failed to load installed plugin');
    }
  }

  return results;
}

/** Validate that a loaded module satisfies the IMConnectorPlugin contract. */
function validatePluginInterface(plugin: IMConnectorPlugin, source: string, log: FastifyBaseLogger): boolean {
  if (!plugin.id || typeof plugin.id !== 'string') {
    log.warn({ source }, '[IMConnectorLoader] Plugin missing `id` — skipped');
    return false;
  }
  if (!plugin.definition || typeof plugin.definition !== 'object') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `definition` — skipped');
    return false;
  }
  if (typeof plugin.createAdapter !== 'function') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `createAdapter()` — skipped');
    return false;
  }
  if (typeof plugin.isConfigured !== 'function') {
    log.warn({ source, id: plugin.id }, '[IMConnectorLoader] Plugin missing `isConfigured()` — skipped');
    return false;
  }
  return true;
}

/**
 * Load all IM connector plugins (built-in + installed + legacy external).
 * IDs that conflict with built-in IDs are rejected.
 */
export async function loadAllIMConnectors(log: FastifyBaseLogger, projectRoot?: string): Promise<IMConnectorPlugin[]> {
  const builtins = await loadBuiltinConnectors();
  const builtinIds = new Set(builtins.map((c) => c.id));

  // Phase B: load from .cat-cafe/plugins/ directory
  const installed = projectRoot ? await loadInstalledPlugins(projectRoot, log) : [];

  // Legacy: load from IM_CONNECTOR_PLUGINS env var (npm packages)
  const legacyExternals = await loadExternalConnectors(process.env.IM_CONNECTOR_PLUGINS, log);

  // Merge installed + legacy, rejecting ID conflicts
  const allExternals = [...installed, ...legacyExternals];
  const validExternals: IMConnectorPlugin[] = [];
  const seenIds = new Set<string>();

  for (const ext of allExternals) {
    if (builtinIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[IMConnectorLoader] External connector ID conflicts with built-in — skipped');
      continue;
    }
    if (seenIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[IMConnectorLoader] Duplicate external connector ID — skipped');
      continue;
    }
    seenIds.add(ext.id);
    validExternals.push(ext);
  }

  const all = [...builtins, ...validExternals];
  log.info(
    { builtin: builtins.length, installed: installed.length, legacy: legacyExternals.length, total: all.length },
    '[IMConnectorLoader] All IM connectors loaded',
  );
  return all;
}
