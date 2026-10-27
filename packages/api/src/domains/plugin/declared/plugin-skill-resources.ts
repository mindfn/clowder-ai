import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { PluginManagerSkillConflict } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../../../config/mount/mount-rules-store.js';
import { addSkill } from '../../../skills/skill-manage.js';
import { activeMountTargets } from '../../../skills/skill-mount-ops.js';
import { classifyMountPath } from '../../../skills/skill-sync-engine.js';
import { createSkillSymlink } from '../../../utils/skill-mount.js';
import { packageDirectoryName } from '../external-runtime/filesystem-package-locator.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import { pluginResourceRoot } from './declared-resource-paths.js';
import type { DeclaredStaticResourceHost } from './declared-static-resources.js';

export interface ResolvePluginSkillConflict {
  skillName: string;
  mountPointId: string;
  revision: string;
}

export class PluginSkillConflictChangedError extends Error {}

/** Reads the existing skill registry and mount paths; no parallel durable resource registry. */
export class PluginSkillResources {
  constructor(
    private readonly host: Pick<DeclaredStaticResourceHost, 'projectRoot' | 'resourcesRoot' | 'persistCapabilities'>,
  ) {}

  async read(pkg: PluginPackageRecord): Promise<PluginManagerSkillConflict[]> {
    if (this.host.persistCapabilities === false || !pkg.manifest) return [];
    const root = this.host.projectRoot;
    const config = await readCapabilitiesConfig(root);
    const rules = await readMountRules(root, root);
    const conflicts: PluginManagerSkillConflict[] = [];
    for (const skill of pkg.manifest.contributions ?? []) {
      if (skill.type !== 'skill') continue;
      const name = basename(skill.path);
      const existing = config?.capabilities.find((c) => c.type === 'skill' && c.id === name);
      const source = resolve(
        pluginResourceRoot(this.host, pkg.pluginId),
        packageDirectoryName(pkg.packageDigest),
        'skills',
      );
      const builtIn = join(root, 'cat-cafe-skills', name);
      const builtInExists = await lstat(builtIn).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if ((existing && existing.pluginId !== pkg.pluginId) || (builtInExists && existing?.pluginId !== pkg.pluginId)) {
        const oldSource = existing?.skillsSource ? resolve(root, existing.skillsSource, name) : builtIn;
        conflicts.push({
          skillName: name,
          mountPointId: 'registration',
          source: existing?.pluginId ? `Plugin: ${existing.pluginId}` : 'Built-in skill',
          ...(existing?.pluginId ? { sourcePluginId: existing.pluginId } : {}),
          canResolve: true,
          path: relative(root, oldSource),
          revision: createHash('sha256')
            .update(JSON.stringify(existing ?? { builtIn }))
            .digest('hex'),
        });
        continue;
      }
      // Disabled/unregistered skills have no requested mount to diagnose.
      if (!existing || existing.mountPaths?.length === 0) continue;
      for (const target of activeMountTargets(root, rules)) {
        if (existing.mountPaths && !existing.mountPaths.includes(target.id)) continue;
        for (const dir of target.dirs) {
          const directory = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (!directory) continue;
          if (!directory.isDirectory() || directory.isSymbolicLink()) {
            conflicts.push({
              skillName: name,
              mountPointId: target.id,
              path: relative(root, dir),
              source: 'Mount directory is blocked',
              canResolve: false,
              revision: createHash('sha256')
                .update(JSON.stringify([directory.dev, directory.ino, directory.mtimeMs]))
                .digest('hex'),
            });
            continue;
          }
          const path = join(dir, name);
          if ((await classifyMountPath(path, source, name)) !== 'conflict') continue;
          const stat = await lstat(path);
          const link = stat.isSymbolicLink() ? await readlink(path) : '';
          const writable = (await realpath(dir)) === resolve(await realpath(root), relative(root, dir));
          const revision = createHash('sha256')
            .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, link]))
            .digest('hex');
          conflicts.push({
            skillName: name,
            mountPointId: target.id,
            path: relative(root, path),
            source: link ? `Existing link: ${link}` : 'Local file or directory',
            canResolve: writable,
            revision,
          });
        }
      }
    }
    return conflicts;
  }

  async resolve(pkg: PluginPackageRecord, request: ResolvePluginSkillConflict): Promise<{ backupPath: string }> {
    if (this.host.persistCapabilities === false)
      throw new PluginSkillConflictChangedError('Skill mounts are read-only in this deployment');
    return withCapabilityLock(this.host.projectRoot, async () => {
      const conflict = (await this.read(pkg)).find(
        (c) => c.skillName === request.skillName && c.mountPointId === request.mountPointId,
      );
      if (!conflict?.canResolve || conflict.revision !== request.revision) {
        throw new PluginSkillConflictChangedError('Skill conflict changed; refresh before choosing a source');
      }
      const root = this.host.projectRoot;
      const source = resolve(
        pluginResourceRoot(this.host, pkg.pluginId),
        packageDirectoryName(pkg.packageDigest),
        'skills',
      );
      await realpath(join(source, request.skillName, 'SKILL.md'));
      if (conflict.mountPointId === 'registration') {
        const previous = await readCapabilitiesConfig(root);
        if (!previous) throw new PluginSkillConflictChangedError('Skill registry is unavailable');
        const existing = previous.capabilities.find((c) => c.type === 'skill' && c.id === request.skillName);
        const oldSource = existing?.skillsSource ?? 'cat-cafe-skills';
        const next = structuredClone(previous);
        next.capabilities = next.capabilities.filter((c) => !(c.type === 'skill' && c.id === request.skillName));
        next.capabilities.push({
          id: request.skillName,
          type: 'skill',
          source: 'cat-cafe',
          pluginId: pkg.pluginId,
          enabled: true,
          skillsSource: oldSource,
          ...(existing?.mountPaths ? { mountPaths: existing.mountPaths } : {}),
        });
        await writeCapabilitiesConfig(root, next);
        try {
          await addSkill(root, request.skillName, source, {
            pluginId: pkg.pluginId,
            skillsSource: relative(root, source),
            mountRules: await readMountRules(root, root),
          });
        } catch (error) {
          await writeCapabilitiesConfig(root, previous);
          throw error;
        }
        // Switching the registry source never removes the previous source files.
        return { backupPath: conflict.path };
      }
      const path = resolve(root, conflict.path);
      // Keep user content permanently beside its mount; never overwrite or delete a blocker.
      const backup = join(dirname(path), `.${request.skillName}.backup-${randomUUID()}`);
      await rename(path, backup);
      try {
        const target = join(source, request.skillName);
        await realpath(join(target, 'SKILL.md'));
        await createSkillSymlink(process.platform === 'win32' ? target : relative(dirname(path), target), path);
      } catch (error) {
        await rename(backup, path);
        throw error;
      }
      return { backupPath: relative(root, backup) };
    });
  }
}
