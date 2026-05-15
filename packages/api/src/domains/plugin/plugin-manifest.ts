import { readFileSync } from 'node:fs';
import type { PluginConfigField, PluginHealthCheck, PluginManifest, PluginResourceDef } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';

const SYSTEM_ENV_DENYLIST_PREFIXES = [
  'CAT_CAFE_',
  'REDIS_',
  'DATABASE_',
  'API_SERVER_',
  'FRONTEND_',
  'PREVIEW_',
  'AGENT_KEY_',
  'JWT_',
  'SESSION_',
];

const SYSTEM_ENV_DENYLIST_EXACT = new Set(['NODE_OPTIONS', 'NODE_ENV', 'PATH', 'HOME', 'SHELL', 'PORT']);

const SUPPORTED_RESOURCE_TYPES = new Set(['skill', 'mcp', 'limb']);
const DEFERRED_RESOURCE_TYPES = new Set(['schedule']);

export const BUILTIN_PLUGIN_IDS = new Set<string>();

export interface EnvSafetyResult {
  ok: boolean;
  errors: string[];
}

function isSystemEnv(envName: string): boolean {
  const upper = envName.toUpperCase();
  if (SYSTEM_ENV_DENYLIST_EXACT.has(upper)) return true;
  return SYSTEM_ENV_DENYLIST_PREFIXES.some((p) => upper.startsWith(p));
}

export function validateEnvSafety(manifest: PluginManifest, existingClaims: Map<string, string>): EnvSafetyResult {
  const errors: string[] = [];
  const pluginPrefix = manifest.id.toUpperCase().replace(/-/g, '_') + '_';

  for (const field of manifest.config) {
    if (isSystemEnv(field.envName)) {
      errors.push(`'${field.envName}' is a reserved system variable`);
      continue;
    }

    if (!manifest.builtin && !field.envName.toUpperCase().startsWith(pluginPrefix)) {
      errors.push(`Community plugin '${manifest.id}' env '${field.envName}' must start with '${pluginPrefix}'`);
      continue;
    }

    const owner = existingClaims.get(field.envName);
    if (owner && owner !== manifest.id) {
      errors.push(`'${field.envName}' already claimed by plugin '${owner}'`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parsePluginManifest(yamlPath: string): PluginManifest {
  const raw = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(raw) as Record<string, unknown>;

  const id = doc['id'];
  const name = doc['name'];
  const version = doc['version'];
  if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`Invalid plugin manifest at ${yamlPath}: id, name, and version must be strings`);
  }
  if (!/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new Error(
      `Invalid plugin id '${id}': must start with a letter, contain only a-z, 0-9, hyphens, no trailing hyphen`,
    );
  }

  const config: PluginConfigField[] = [];
  const rawConfig = doc['config'];
  if (Array.isArray(rawConfig)) {
    for (const c of rawConfig) {
      const rc = c as Record<string, unknown>;
      if (typeof rc['envName'] !== 'string' || typeof rc['label'] !== 'string') {
        throw new Error(`Invalid config entry in ${yamlPath}: envName and label must be strings`);
      }
      const envName = rc['envName'];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        throw new Error(`Invalid envName '${envName}': must be a valid shell variable name`);
      }
      config.push({
        envName,
        label: rc['label'],
        sensitive: rc['sensitive'] === true,
        required: rc['required'] !== false,
      });
    }
  }

  const resources: PluginResourceDef[] = [];
  const rawResources = doc['resources'];
  if (Array.isArray(rawResources)) {
    for (const r of rawResources) {
      const rr = r as Record<string, unknown>;
      const type = rr['type'] as string;
      if (DEFERRED_RESOURCE_TYPES.has(type)) {
        console.warn(`[PluginManifest] resource type '${type}' not yet supported, skipping`);
        continue;
      }
      if (!SUPPORTED_RESOURCE_TYPES.has(type)) continue;

      const path = rr['path'] as string | undefined;
      if (path && (path.includes('..') || path.startsWith('/'))) {
        throw new Error(`Invalid resource path '${path}': must be relative without '..'`);
      }

      const rawArgs = rr['args'];
      let args: string[] | undefined;
      if (rawArgs != null) {
        if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === 'string')) {
          throw new Error(`Invalid resource args in ${yamlPath}: must be an array of strings`);
        }
        args = rawArgs as string[];
      }

      const command = rr['command'];
      if (command != null && typeof command !== 'string') {
        throw new Error(`Invalid resource command in ${yamlPath}: must be a string`);
      }

      resources.push({
        type: type as PluginResourceDef['type'],
        path,
        name: rr['name'] as string | undefined,
        command: command as string | undefined,
        args,
        transport: rr['transport'] as string | undefined,
      });
    }
  }

  let healthCheck: PluginHealthCheck | undefined;
  const rawHC = doc['healthCheck'] as Record<string, unknown> | undefined;
  if (rawHC) {
    const limbCommand = rawHC['limbCommand'] as string | undefined;
    const mcpProbe = rawHC['mcpProbe'] as string | undefined;
    if (limbCommand || mcpProbe) {
      healthCheck = { limbCommand, mcpProbe };
    }
  }

  const docsUrl = typeof doc['docsUrl'] === 'string' ? doc['docsUrl'] : undefined;
  const rawSteps = doc['setupSteps'];
  const setupSteps = Array.isArray(rawSteps) ? rawSteps.filter((s): s is string => typeof s === 'string') : undefined;

  return {
    id,
    name,
    version,
    description: doc['description'] as string | undefined,
    icon: doc['icon'] as string | undefined,
    iconBg: typeof doc['iconBg'] === 'string' ? doc['iconBg'] : undefined,
    builtin: false,
    docsUrl,
    setupSteps: setupSteps && setupSteps.length > 0 ? setupSteps : undefined,
    config,
    healthCheck,
    resources,
  };
}
