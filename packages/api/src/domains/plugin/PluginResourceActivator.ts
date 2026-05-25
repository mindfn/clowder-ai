import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CapabilitiesConfig,
  CapabilityEntry,
  ILimbNode,
  PluginManifest,
  PluginResourceDef,
} from '@cat-cafe/shared';
import type { LimbRegistry } from '../limb/LimbRegistry.js';
import { resolvePluginResourcePath, resourceCapId, resourcePathBasename } from './PluginRegistry.js';
import { resolvePluginEnv } from './plugin-config-store.js';

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

export type LimbAdapterFactory = (pluginId: string, limbYamlPath: string) => Promise<ILimbNode>;

export interface PluginResourceActivatorDeps {
  resolveProjectRoot: () => string;
  pluginsDir: string;
  limbRegistry: LimbRegistry;
  readCapabilities: () => Promise<CapabilitiesConfig | null>;
  writeCapabilities: (config: CapabilitiesConfig) => Promise<void>;
  withCapabilityLock: <T>(fn: () => Promise<T>) => Promise<T>;
  limbAdapterFactory?: LimbAdapterFactory;
}

export function withPersistedLimbNodeId<T extends ILimbNode>(node: T, persistedNodeId?: string): T {
  if (!persistedNodeId || persistedNodeId === node.nodeId) return node;

  const clone = Object.create(Object.getPrototypeOf(node));
  const descriptors: PropertyDescriptorMap = { ...Object.getOwnPropertyDescriptors(node) };
  descriptors.nodeId = {
    value: persistedNodeId,
    enumerable: true,
    configurable: true,
  };
  Object.defineProperties(clone, descriptors);
  return clone as T;
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

    const skillSourceDir = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    if (!existsSync(skillSourceDir)) {
      throw new Error(`Skill source not found: ${skillSourceDir}`);
    }
    const skillName = resourcePathBasename(resource.path);

    const createdLinks: string[] = [];
    try {
      for (const providerDir of PROVIDER_DIRS) {
        const skillsDir = join(this.deps.resolveProjectRoot(), providerDir);
        if (await this.shouldSkipDirectoryLevelSkillsSymlink(skillsDir, dirname(skillSourceDir))) continue;
        await mkdir(skillsDir, { recursive: true });
        const linkPath = join(skillsDir, skillName);
        if (await this.ensureSymlink(linkPath, skillSourceDir)) createdLinks.push(linkPath);
      }
      await this.upsertCapabilityEntry(manifest, resource, true);
    } catch (err) {
      for (const linkPath of createdLinks) {
        await this.removeOwnedSymlink(linkPath, skillSourceDir);
      }
      throw err;
    }
  }

  private async deactivateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const skillSourceDir = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    const skillName = resourcePathBasename(resource.path);

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

    const yamlPath = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    const node = await this.deps.limbAdapterFactory(manifest.id, yamlPath);
    await this.upsertCapabilityEntry(manifest, resource, true, node.nodeId);
    try {
      await this.deps.limbRegistry.register(node);
    } catch (err) {
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
        const yamlPath = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
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
      const previous = config ? structuredClone(config) : null;
      const cap: CapabilitiesConfig = config ? structuredClone(config) : { version: 1, capabilities: [] };
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
          existing.mcpServer = this.buildMcpServer(manifest, resource);
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
          entry.mcpServer = this.buildMcpServer(manifest, resource);
        }

        cap.capabilities.push(entry);
      }

      await this.writeCapabilitiesWithRollback(previous, cap);
    });
  }

  private async removeCapabilityEntry(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;
      const previous = structuredClone(config);
      const next = structuredClone(config);

      const capId = resourceCapId(manifest.id, resource);
      next.capabilities = next.capabilities.filter((c) => !(c.id === capId && c.pluginId === manifest.id));
      await this.writeCapabilitiesWithRollback(previous, next);
    });
  }

  async syncPluginEnv(manifest: PluginManifest): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;
      const previous = structuredClone(config);
      const next = structuredClone(config);

      const mcpEnv = this.buildMcpEnv(manifest);
      let changed = false;
      for (const cap of next.capabilities) {
        if (cap.pluginId !== manifest.id || cap.type !== 'mcp' || !cap.mcpServer) continue;
        cap.mcpServer.env = mcpEnv.env;
        changed = true;
      }
      if (changed) await this.writeCapabilitiesWithRollback(previous, next);
    });
  }

  private buildMcpServer(
    manifest: PluginManifest,
    resource: PluginResourceDef,
  ): NonNullable<CapabilityEntry['mcpServer']> {
    return {
      command: resource.command!,
      args: resource.args ?? [],
      transport: (resource.transport as 'stdio' | 'streamableHttp') ?? 'stdio',
      workingDir: join(this.deps.pluginsDir, manifest.id),
      ...this.buildMcpEnv(manifest),
    };
  }

  private buildMcpEnv(manifest: PluginManifest): { env?: Record<string, string> } {
    if (manifest.config.length === 0) return {};
    const resolved = resolvePluginEnv([manifest]);
    const env: Record<string, string> = {};
    for (const field of manifest.config) {
      const val = resolved[field.envName];
      if (val) env[field.envName] = val;
    }
    return Object.keys(env).length > 0 ? { env } : {};
  }

  private async writeCapabilitiesWithRollback(
    previous: CapabilitiesConfig | null,
    next: CapabilitiesConfig,
  ): Promise<void> {
    try {
      await this.deps.writeCapabilities(next);
    } catch (err) {
      const rollback = previous ?? { version: 1, capabilities: [] };
      try {
        await this.deps.writeCapabilities(structuredClone(rollback));
      } catch {
        /* If regeneration fails after writing, the rollback write still restores persisted state. */
      }
      throw err;
    }
  }

  private async shouldSkipDirectoryLevelSkillsSymlink(skillsDir: string, expectedRoot: string): Promise<boolean> {
    try {
      const stat = await lstat(skillsDir);
      if (!stat.isSymbolicLink()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    let mountedRoot: string;
    let expectedRealRoot: string;
    try {
      mountedRoot = await realpath(skillsDir);
      expectedRealRoot = await realpath(expectedRoot);
    } catch (err) {
      throw new Error(
        `Invalid directory-level plugin skill mount at ${skillsDir}: symlink must resolve to ${expectedRoot}. ${
          (err as Error).message
        }`,
      );
    }

    if (mountedRoot !== expectedRealRoot) {
      throw new Error(
        `Refusing to mount plugin skill into directory-level skills symlink at ${skillsDir}: resolves to ${mountedRoot}, expected ${expectedRealRoot}`,
      );
    }

    return true;
  }

  private async ensureSymlink(linkPath: string, target: string): Promise<boolean> {
    try {
      const s = await lstat(linkPath);
      if (s.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const existing = await readlink(linkPath);
        if (existing === target) return false;
        throw new Error(`Refusing to overwrite existing symlink at ${linkPath} (current target: ${existing})`);
      } else {
        throw new Error(`Refusing to overwrite non-symlink at ${linkPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    }
    await symlink(target, linkPath);
    return true;
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
