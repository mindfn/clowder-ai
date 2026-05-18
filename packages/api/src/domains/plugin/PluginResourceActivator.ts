import { existsSync } from 'node:fs';
import { lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CapabilitiesConfig,
  CapabilityEntry,
  ILimbNode,
  PluginManifest,
  PluginResourceDef,
} from '@cat-cafe/shared';
import type { LimbRegistry } from '../limb/LimbRegistry.js';
import { resourceCapId } from './PluginRegistry.js';
import { readPluginConfig } from './plugin-config-store.js';

const PROVIDER_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

export interface ActivationResult {
  type: string;
  path?: string;
  name?: string;
  ok: boolean;
  error?: string;
}

export interface ActivatePluginResult {
  status: 'success' | 'partial' | 'failed';
  resources: ActivationResult[];
}

export type LimbAdapterFactory = (
  pluginId: string,
  limbYamlPath: string,
  pluginConfig: Record<string, string>,
) => Promise<ILimbNode>;

export interface PluginResourceActivatorDeps {
  resolveProjectRoot: () => string;
  pluginsDir: string;
  limbRegistry: LimbRegistry;
  readCapabilities: () => Promise<CapabilitiesConfig | null>;
  writeCapabilities: (config: CapabilitiesConfig) => Promise<void>;
  withCapabilityLock: <T>(fn: () => Promise<T>) => Promise<T>;
  limbAdapterFactory?: LimbAdapterFactory;
}

export class PluginResourceActivator {
  private readonly deps: PluginResourceActivatorDeps;

  constructor(deps: PluginResourceActivatorDeps) {
    this.deps = deps;
  }

  async enablePlugin(manifest: PluginManifest): Promise<ActivatePluginResult> {
    const results: ActivationResult[] = [];

    for (const resource of manifest.resources) {
      try {
        await this.activateResource(manifest, resource);
        results.push({ type: resource.type, path: resource.path, name: resource.name, ok: true });
      } catch (err) {
        results.push({
          type: resource.type,
          path: resource.path,
          name: resource.name,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    const allOk = results.every((r) => r.ok);
    const someOk = results.some((r) => r.ok);
    return {
      status: allOk ? 'success' : someOk ? 'partial' : 'failed',
      resources: results,
    };
  }

  async disablePlugin(manifest: PluginManifest): Promise<ActivatePluginResult> {
    const results: ActivationResult[] = [];

    for (const resource of manifest.resources) {
      try {
        await this.deactivateResource(manifest, resource);
        results.push({ type: resource.type, path: resource.path, name: resource.name, ok: true });
      } catch (err) {
        results.push({
          type: resource.type,
          path: resource.path,
          name: resource.name,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    const allOk = results.every((r) => r.ok);
    const someOk = results.some((r) => r.ok);
    return {
      status: allOk ? 'success' : someOk ? 'partial' : 'failed',
      resources: results,
    };
  }

  private async activateResource(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    switch (resource.type) {
      case 'skill':
        await this.activateSkill(manifest, resource);
        break;
      case 'limb':
        await this.activateLimb(manifest, resource);
        break;
      case 'mcp':
        await this.activateMcp(manifest, resource);
        break;
      default:
        throw new Error(`Unsupported resource type: ${resource.type}`);
    }
  }

  private async deactivateResource(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    switch (resource.type) {
      case 'skill':
        await this.deactivateSkill(manifest, resource);
        break;
      case 'limb':
        await this.deactivateLimb(manifest, resource);
        break;
      case 'mcp':
        await this.deactivateMcp(manifest, resource);
        break;
      default:
        throw new Error(`Unsupported resource type: ${resource.type}`);
    }
  }

  private async activateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) throw new Error('Skill resource must have a path');

    const skillSourceDir = join(this.deps.pluginsDir, manifest.id, resource.path);
    if (!existsSync(skillSourceDir)) {
      throw new Error(`Skill source not found: ${skillSourceDir}`);
    }
    const skillName = resource.path.split('/').pop()!;

    for (const providerDir of PROVIDER_DIRS) {
      const skillsDir = join(this.deps.resolveProjectRoot(), providerDir);
      await mkdir(skillsDir, { recursive: true });
      const linkPath = join(skillsDir, skillName);
      await this.ensureSymlink(linkPath, skillSourceDir);
    }

    await this.upsertCapabilityEntry(manifest, resource, true);
  }

  private async deactivateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const skillSourceDir = join(this.deps.pluginsDir, manifest.id, resource.path);
    const skillName = resource.path.split('/').pop()!;

    for (const providerDir of PROVIDER_DIRS) {
      const linkPath = join(this.deps.resolveProjectRoot(), providerDir, skillName);
      await this.removeOwnedSymlink(linkPath, skillSourceDir);
    }

    await this.upsertCapabilityEntry(manifest, resource, false);
  }

  private async activateLimb(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) throw new Error('Limb resource must have a path');
    if (!this.deps.limbAdapterFactory) {
      throw new Error('No limb adapter factory configured');
    }

    const yamlPath = join(this.deps.pluginsDir, manifest.id, resource.path);
    const pluginConfig = readPluginConfig(this.deps.resolveProjectRoot(), manifest.id);
    const node = await this.deps.limbAdapterFactory(manifest.id, yamlPath, pluginConfig);
    await this.upsertCapabilityEntry(manifest, resource, true, node.nodeId);
    try {
      await this.deps.limbRegistry.register(node);
    } catch (err) {
      if (err instanceof Error && err.message.includes('already registered')) return;
      await this.removeCapabilityEntry(manifest, resource);
      throw err;
    }
  }

  private async deactivateLimb(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const capId = resourceCapId(manifest.id, resource);
    const config = await this.deps.readCapabilities();
    let nodeId = config?.capabilities.find((c) => c.id === capId)?.limbNodeId;
    if (!nodeId) {
      try {
        const yamlPath = join(this.deps.pluginsDir, manifest.id, resource.path);
        const { loadLimbDeclaration } = await import('../limb/limb-yaml-loader.js');
        nodeId = loadLimbDeclaration(yamlPath).nodeId;
      } catch {
        /* YAML unreadable and no persisted nodeId — skip deregister */
      }
    }

    if (nodeId) {
      this.deps.limbRegistry.deregister(nodeId);
    }

    await this.removeCapabilityEntry(manifest, resource);
  }

  private async activateMcp(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.command) {
      throw new Error('MCP resource must declare a command');
    }
    await this.upsertCapabilityEntry(manifest, resource, true);
  }

  private async deactivateMcp(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    await this.removeCapabilityEntry(manifest, resource);
  }

  private async upsertCapabilityEntry(
    manifest: PluginManifest,
    resource: PluginResourceDef,
    enabled: boolean,
    limbNodeId?: string,
  ): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      const cap: CapabilitiesConfig = config ?? { version: 1, capabilities: [] };
      const capId = resourceCapId(manifest.id, resource);

      const existing = cap.capabilities.find((c) => c.id === capId);
      if (existing) {
        if (existing.pluginId !== undefined && existing.pluginId !== manifest.id) {
          throw new Error(`Capability '${capId}' is already owned by plugin '${existing.pluginId}'`);
        }
        if (existing.pluginId === undefined) {
          throw new Error(`Capability '${capId}' exists as a non-plugin entry and cannot be claimed`);
        }
        existing.enabled = enabled;
        existing.pluginId = manifest.id;
        if (limbNodeId) existing.limbNodeId = limbNodeId;
        if (resource.type === 'mcp' && resource.command) {
          existing.mcpServer = {
            command: resource.command,
            args: resource.args ?? [],
            transport: (resource.transport as 'stdio' | 'streamableHttp') ?? 'stdio',
            ...this.buildMcpEnv(manifest),
          };
        }
      } else {
        const entry: CapabilityEntry = {
          id: capId,
          type: resource.type as 'mcp' | 'skill' | 'limb',
          enabled,
          source: 'cat-cafe',
          pluginId: manifest.id,
          ...(limbNodeId ? { limbNodeId } : {}),
        };

        if (resource.type === 'mcp' && resource.command) {
          entry.mcpServer = {
            command: resource.command,
            args: resource.args ?? [],
            transport: (resource.transport as 'stdio' | 'streamableHttp') ?? 'stdio',
            ...this.buildMcpEnv(manifest),
          };
        }

        cap.capabilities.push(entry);
      }

      await this.deps.writeCapabilities(cap);
    });
  }

  private async removeCapabilityEntry(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;

      const capId = resourceCapId(manifest.id, resource);
      config.capabilities = config.capabilities.filter((c) => !(c.id === capId && c.pluginId === manifest.id));
      await this.deps.writeCapabilities(config);
    });
  }

  async syncPluginEnv(manifest: PluginManifest): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;

      const mcpEnv = this.buildMcpEnv(manifest);
      let changed = false;
      for (const cap of config.capabilities) {
        if (cap.pluginId !== manifest.id || cap.type !== 'mcp' || !cap.mcpServer) continue;
        cap.mcpServer.env = mcpEnv.env;
        changed = true;
      }
      if (changed) await this.deps.writeCapabilities(config);
    });
  }

  private buildMcpEnv(manifest: PluginManifest): { env?: Record<string, string> } {
    if (manifest.config.length === 0) return {};
    const projectRoot = this.deps.resolveProjectRoot();
    const stored = readPluginConfig(projectRoot, manifest.id);
    const env: Record<string, string> = {};
    for (const field of manifest.config) {
      const val = stored[field.envName];
      if (val) env[field.envName] = val;
    }
    return Object.keys(env).length > 0 ? { env } : {};
  }

  private async ensureSymlink(linkPath: string, target: string): Promise<void> {
    try {
      const s = await lstat(linkPath);
      if (s.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const existing = await readlink(linkPath);
        if (existing === target) return;
        throw new Error(`Refusing to overwrite existing symlink at ${linkPath} (current target: ${existing})`);
      } else {
        throw new Error(`Refusing to overwrite non-symlink at ${linkPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    }
    await symlink(target, linkPath);
  }

  private async removeOwnedSymlink(linkPath: string, expectedTarget: string): Promise<void> {
    try {
      const s = await lstat(linkPath);
      if (!s.isSymbolicLink()) return;
      const { readlink } = await import('node:fs/promises');
      const actual = await readlink(linkPath);
      if (actual !== expectedTarget) return;
      await rm(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}
