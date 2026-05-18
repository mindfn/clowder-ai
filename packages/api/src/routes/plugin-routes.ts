/**
 * Plugin Routes — F202 Plugin Framework
 *
 * Dynamic plugin discovery, configuration, and resource lifecycle management.
 */

import { join } from 'node:path';
import type { PluginInfo } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../domains/limb/limb-yaml-loader.js';
import type { PluginRegistry } from '../domains/plugin/PluginRegistry.js';
import type { PluginResourceActivator } from '../domains/plugin/PluginResourceActivator.js';
import { resolvePluginEnv, writePluginConfig } from '../domains/plugin/plugin-config-store.js';
import { validateEnvSafety } from '../domains/plugin/plugin-manifest.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface PluginRoutesOpts {
  pluginRegistry: PluginRegistry;
  pluginActivator: PluginResourceActivator;
  limbRegistry: LimbRegistry;
  pluginsDir: string;
}

export function registerPluginRoutes(app: FastifyInstance, opts: PluginRoutesOpts): void {
  const { pluginRegistry, pluginActivator, limbRegistry, pluginsDir } = opts;

  app.get('/api/plugins', async () => {
    const projectRoot = resolveActiveProjectRoot();
    const capabilities = await readCapabilitiesConfig(projectRoot);
    const manifests = pluginRegistry.getAllManifests();

    const envSnapshot = resolvePluginEnv(manifests);
    const plugins: PluginInfo[] = manifests.map((m) => pluginRegistry.getPluginInfo(m, capabilities, envSnapshot));

    return { plugins };
  });

  app.get<{ Params: { id: string } }>('/api/plugins/:id', async (request, reply) => {
    const { id } = request.params;
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const projectRoot = resolveActiveProjectRoot();
    const capabilities = await readCapabilitiesConfig(projectRoot);
    const envSnapshot = resolvePluginEnv([manifest]);
    return pluginRegistry.getPluginInfo(manifest, capabilities, envSnapshot);
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/enable', async (request, reply) => {
    if (!LOOPBACK_ADDRS.has(request.ip)) {
      reply.status(403);
      return { error: 'Plugin write endpoint is loopback-only' };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { id } = request.params;
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const result = await pluginActivator.enablePlugin(manifest);

    try {
      const auditLog = getEventAuditLog();
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target: 'plugin-enable', pluginId: id, operator },
      });
    } catch {
      /* audit failure is non-critical */
    }

    return result;
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/disable', async (request, reply) => {
    if (!LOOPBACK_ADDRS.has(request.ip)) {
      reply.status(403);
      return { error: 'Plugin write endpoint is loopback-only' };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { id } = request.params;
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const result = await pluginActivator.disablePlugin(manifest);

    try {
      const auditLog = getEventAuditLog();
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target: 'plugin-disable', pluginId: id, operator },
      });
    } catch {
      /* audit failure is non-critical */
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: { updates: { name: string; value: string | null }[] } }>(
    '/api/plugins/:id/config',
    async (request, reply) => {
      if (!LOOPBACK_ADDRS.has(request.ip)) {
        reply.status(403);
        return { error: 'Plugin config endpoint is loopback-only' };
      }

      const operator = resolveHeaderUserId(request);
      if (!operator) {
        reply.status(400);
        return { error: 'Identity required (X-Cat-Cafe-User header)' };
      }

      const { id } = request.params;
      const manifest = pluginRegistry.getManifest(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Plugin '${id}' not found` };
      }

      const body = request.body as { updates?: { name: string; value: string | null }[] } | undefined;
      if (!body?.updates || !Array.isArray(body.updates) || body.updates.length === 0) {
        reply.status(400);
        return { error: 'Missing or empty updates array' };
      }

      for (const u of body.updates) {
        if (typeof u.name !== 'string' || (u.value !== null && typeof u.value !== 'string')) {
          reply.status(400);
          return { error: 'Each update must have a string name and a string|null value' };
        }
      }

      const allowedEnvNames = new Set(manifest.config.map((f) => f.envName));
      for (const u of body.updates) {
        if (!allowedEnvNames.has(u.name)) {
          reply.status(400);
          return { error: `'${u.name}' is not declared in plugin '${id}' config` };
        }
      }

      const envClaims = new Map<string, string>();
      for (const m of pluginRegistry.getAllManifests()) {
        if (m.id === id) continue;
        for (const f of m.config) envClaims.set(f.envName, m.id);
      }
      const safety = validateEnvSafety(manifest, envClaims);
      if (!safety.ok) {
        reply.status(400);
        return { error: `Env safety: ${safety.errors.join('; ')}` };
      }

      const projectRoot = resolveActiveProjectRoot();
      writePluginConfig(projectRoot, id, body.updates);

      await pluginActivator.syncPluginEnv(manifest);

      try {
        const auditLog = getEventAuditLog();
        await auditLog.append({
          type: AuditEventTypes.CONFIG_UPDATED,
          data: {
            target: 'plugin-config',
            pluginId: id,
            keys: body.updates.map((u) => u.name),
            operator,
          },
        });
      } catch {
        // audit failure is non-critical
      }

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/test', async (request, reply) => {
    if (!LOOPBACK_ADDRS.has(request.ip)) {
      reply.status(403);
      return { error: 'Plugin test endpoint is loopback-only' };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const { id } = request.params;
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    if (!manifest.healthCheck) {
      reply.status(400);
      return { error: `Plugin '${id}' does not declare a healthCheck` };
    }

    if (manifest.healthCheck.limbCommand) {
      const limbResource = manifest.resources.find((r) => r.type === 'limb');
      if (!limbResource?.path) {
        reply.status(400);
        return { error: 'Plugin declares limbCommand but has no limb resource' };
      }

      const yamlPath = join(pluginsDir, id, limbResource.path);
      const decl = (() => {
        try {
          return loadLimbDeclaration(yamlPath);
        } catch {
          return null;
        }
      })();
      if (!decl) {
        return { ok: false, status: 'offline', error: 'Failed to load limb declaration' };
      }

      const allCommands = decl.capabilities.flatMap((c) => c.commands);
      if (!allCommands.includes(manifest.healthCheck.limbCommand)) {
        reply.status(400);
        return {
          error: `limbCommand '${manifest.healthCheck.limbCommand}' not found in plugin's limb capabilities`,
        };
      }

      const nodeId = decl.nodeId;

      const handle = limbRegistry.getNodeHandle(nodeId);
      if (!handle) {
        return { ok: false, status: 'offline', error: 'Limb node not registered' };
      }

      const result = await handle.invoke(manifest.healthCheck.limbCommand, {});
      if (!result.success) {
        return { ok: false, status: 'error', error: result.error ?? 'Health check invoke failed' };
      }
      const hcData = result.data as Record<string, unknown> | undefined;
      const hcStatus = (hcData?.status as string) ?? 'unknown';
      if (hcStatus === 'connected' || hcStatus === 'online') {
        return { ok: true, status: hcStatus };
      }
      return {
        ok: false,
        status: hcStatus,
        error: (hcData?.message as string) ?? undefined,
      };
    }

    if (manifest.healthCheck.mcpProbe) {
      reply.status(501);
      return { error: 'mcpProbe healthCheck is not yet implemented' };
    }

    return { ok: false, error: 'No supported healthCheck method' };
  });
}
