import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilitiesConfig,
  PluginInfo,
  PluginManifest,
  PluginResourceStatus,
  PluginStatus,
} from '@cat-cafe/shared';
import { BUILTIN_PLUGIN_IDS, parsePluginManifest, validateEnvSafety } from './plugin-manifest.js';

function maskValue(raw: string | undefined, sensitive: boolean): string | null {
  if (!raw) return null;
  if (sensitive) return '••••••';
  if (raw.length <= 6) return raw;
  return `${raw.slice(0, 6)}****`;
}

export class PluginRegistry {
  private manifests = new Map<string, PluginManifest>();
  private readonly pluginsDir: string;

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir;
  }

  scan(): PluginManifest[] {
    this.manifests.clear();

    if (!existsSync(this.pluginsDir)) return [];

    const envClaims = new Map<string, string>();
    const candidates: { id: string; manifest: PluginManifest; yamlPath: string }[] = [];

    let entries: string[];
    try {
      entries = readdirSync(this.pluginsDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      const pluginDir = join(this.pluginsDir, entry);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const yamlPath = join(pluginDir, 'plugin.yaml');
      if (!existsSync(yamlPath)) continue;

      try {
        const manifest = parsePluginManifest(yamlPath);
        if (manifest.id !== entry) {
          console.warn(`[PluginRegistry] skip ${entry}: manifest id '${manifest.id}' does not match directory name`);
          continue;
        }
        if (BUILTIN_PLUGIN_IDS.has(manifest.id)) {
          console.warn(`[PluginRegistry] skip ${entry}: '${manifest.id}' is a reserved builtin plugin id`);
          continue;
        }
        candidates.push({ id: manifest.id, manifest, yamlPath });
      } catch (err) {
        console.warn(`[PluginRegistry] skip ${entry}: ${(err as Error).message}`);
      }
    }

    for (const { id, manifest, yamlPath } of candidates) {
      const safety = validateEnvSafety(manifest, envClaims);
      if (!safety.ok) {
        console.warn(`[PluginRegistry] skip ${id} (${yamlPath}): env safety: ${safety.errors.join('; ')}`);
        continue;
      }

      for (const field of manifest.config) {
        envClaims.set(field.envName, id);
      }
      this.manifests.set(id, manifest);
    }

    return [...this.manifests.values()];
  }

  getManifest(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId);
  }

  getAllManifests(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  deriveStatus(
    manifest: PluginManifest,
    capabilities: CapabilitiesConfig | null,
    env: Record<string, string | undefined>,
  ): PluginStatus {
    const allConfigured = manifest.config.filter((f) => f.required).every((f) => !!env[f.envName]);

    if (!allConfigured) return 'not_configured';

    if (!capabilities) return 'configured';

    const capEntries = capabilities.capabilities.filter((c) => c.pluginId === manifest.id);

    if (capEntries.length === 0) return 'configured';

    const allEnabled = capEntries.every((c) => c.enabled);
    if (allEnabled && capEntries.length >= manifest.resources.length) return 'enabled';

    const someEnabled = capEntries.some((c) => c.enabled);
    return someEnabled ? 'partial' : 'configured';
  }

  getPluginInfo(
    manifest: PluginManifest,
    capabilities: CapabilitiesConfig | null,
    env: Record<string, string | undefined>,
  ): PluginInfo {
    const status = this.deriveStatus(manifest, capabilities, env);
    const allConfigured = manifest.config.filter((f) => f.required).every((f) => !!env[f.envName]);

    const configWithValues = manifest.config.map((f) => ({
      ...f,
      currentValue: maskValue(env[f.envName], f.sensitive),
      ...(f.oneOf
        ? {
            oneOf: Object.fromEntries(
              Object.entries(f.oneOf).map(([key, fields]) => [
                key,
                fields.map((sub) => ({
                  ...sub,
                  currentValue: maskValue(env[sub.envName], sub.sensitive),
                })),
              ]),
            ),
          }
        : {}),
    }));

    const resourceStatuses: PluginResourceStatus[] = manifest.resources.map((r) => {
      const capEntry = capabilities?.capabilities.find(
        (c) => c.pluginId === manifest.id && c.id === resourceCapId(manifest.id, r),
      );
      return {
        type: r.type,
        path: r.path,
        name: r.name,
        enabled: capEntry?.enabled ?? false,
      };
    });

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      icon: manifest.icon,
      iconBg: manifest.iconBg,
      docsUrl: manifest.docsUrl,
      setupSteps: manifest.setupSteps,
      status,
      configured: allConfigured,
      config: configWithValues,
      healthCheck: manifest.healthCheck,
      resources: resourceStatuses,
      hasHealthCheck: !!manifest.healthCheck?.limbCommand,
    };
  }
}

export function resourceCapId(pluginId: string, resource: { type: string; path?: string; name?: string }): string {
  if (resource.type === 'skill' && resource.path) {
    return resource.path.split('/').pop()!;
  }
  const suffix = resource.path ?? resource.name ?? resource.type;
  return `plugin:${pluginId}:${suffix}`;
}
