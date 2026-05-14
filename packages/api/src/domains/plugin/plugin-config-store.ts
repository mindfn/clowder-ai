import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginManifest } from '@cat-cafe/shared';
import { configEventBus, createChangeSetId } from '../../config/config-event-bus.js';

const CONFIG_DIR = '.cat-cafe';
const PLUGIN_CONFIG_SUBDIR = 'plugin-config';

function resolvePluginConfigDir(projectRoot: string): string {
  return resolve(projectRoot, CONFIG_DIR, PLUGIN_CONFIG_SUBDIR);
}

function resolvePluginConfigPath(projectRoot: string, pluginId: string): string {
  return resolve(resolvePluginConfigDir(projectRoot), `${pluginId}.json`);
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

type StoredValues = Record<string, string | null>;

function readRawConfig(projectRoot: string, pluginId: string): StoredValues {
  const configPath = resolvePluginConfigPath(projectRoot, pluginId);
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: StoredValues = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v;
      else if (v === null) result[k] = null;
    }
    return result;
  } catch {
    return {};
  }
}

export function readPluginConfig(projectRoot: string, pluginId: string): Record<string, string> {
  const raw = readRawConfig(projectRoot, pluginId);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

export function writePluginConfig(
  projectRoot: string,
  pluginId: string,
  updates: { name: string; value: string | null }[],
): { changedKeys: string[] } {
  const dir = resolvePluginConfigDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const existing = readRawConfig(projectRoot, pluginId);
  const changedKeys: string[] = [];

  for (const { name, value } of updates) {
    const oldVal = existing[name] ?? '';
    const newVal = value ?? '';
    if (oldVal !== newVal) changedKeys.push(name);

    if (value == null || value === '') {
      existing[name] = null;
    } else {
      existing[name] = value;
    }
  }

  const configPath = resolvePluginConfigPath(projectRoot, pluginId);
  writeFileAtomic(configPath, `${JSON.stringify(existing, null, 2)}\n`);

  for (const { name, value } of updates) {
    if (value == null || value === '') delete process.env[name];
    else process.env[name] = value;
  }

  if (changedKeys.length > 0) {
    configEventBus.emitChange({
      source: 'secrets',
      scope: 'key',
      changedKeys,
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
  }

  return { changedKeys };
}

export function loadAllPluginConfigs(projectRoot: string, manifests: PluginManifest[]): number {
  let loaded = 0;
  for (const manifest of manifests) {
    const allowedEnvNames = new Set(manifest.config.map((f) => f.envName));
    const raw = readRawConfig(projectRoot, manifest.id);
    for (const [name, value] of Object.entries(raw)) {
      if (!allowedEnvNames.has(name)) continue;
      if (typeof value === 'string') {
        process.env[name] = value;
        loaded++;
      } else if (value === null) {
        delete process.env[name];
      }
    }
  }
  return loaded;
}
