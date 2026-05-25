import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { getServiceConfig, setServiceConfig } from '../domains/services/service-config.js';
import {
  appendServiceLog,
  findPidsByPort,
  readProcessCommand,
  readServiceLogTail,
  resolveServiceScriptPath,
  runServiceScript,
  type ServiceLifecycleAction,
  type ServiceLifecycleRunner,
} from '../domains/services/service-lifecycle.js';
import {
  type FetchServiceHealth,
  fetchServiceHealth,
  getServiceManifest,
  resolveEffectiveServiceConfig,
  resolveServiceEndpoint,
  resolveServiceHealthUrl,
  SERVICE_MANIFESTS,
  type ServiceConfig,
  type ServiceManifest,
} from '../domains/services/service-manifest.js';
import {
  registerServiceLifecycleAuditRoutes,
  SERVICE_LIFECYCLE_AUDIT_TYPE,
  type ServiceLifecycleAuditLog,
} from './services-lifecycle-audit-routes.js';
import {
  buildLifecycleEnv,
  DEFAULT_LIFECYCLE_TIMEOUT_MS,
  getLifecycleRunSettlement,
  lifecycleFailureStatus,
  lifecycleOwnerError,
  requireLifecycleOwner,
  runWithTimeout,
} from './services-lifecycle-helpers.js';
import { createServiceLifecycleLock, holdLifecycleLockUntil, holdStartupGrace } from './services-lifecycle-lock.js';
import {
  createServicePortPartitioner,
  resolveSuggestedServicePort,
  servicePortProbeUnavailableError,
} from './services-lifecycle-port.js';

export interface ServiceLifecycleRouteOptions {
  runScript?: ServiceLifecycleRunner;
  timeoutMs?: number;
  startupGraceMs?: number;
  startupReadinessTimeoutMs?: number;
  startupProbeIntervalMs?: number;
  autoStartEnabled?: boolean;
  findPidsByPort?: (port: number) => Promise<number[]>;
  readProcessCommand?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  serviceConfig?: Partial<{
    get(id: string): ServiceConfig | undefined;
    set(id: string, patch: Partial<ServiceConfig>): ServiceConfig;
  }>;
  auditLog?: ServiceLifecycleAuditLog;
}

type LifecycleReply = { status(code: number): unknown; statusCode?: number };
const STARTUP_RECONCILER_OPERATOR = 'startup-reconciler';
const DEFAULT_STARTUP_READINESS_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_PROBE_INTERVAL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function settleQuietly(waitFor?: Promise<unknown>): Promise<void> | undefined {
  return waitFor?.then(
    () => undefined,
    () => undefined,
  );
}

function createInternalReply(): LifecycleReply {
  return {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

async function waitForServiceReadiness(input: {
  service: ServiceManifest;
  env: NodeJS.ProcessEnv;
  getConfig: (id: string) => ServiceConfig | undefined;
  fetchHealth: FetchServiceHealth;
  timeoutMs: number;
  intervalMs: number;
  stopWhen?: Promise<unknown>;
}): Promise<void> {
  const timeoutMs = Math.max(0, input.timeoutMs);
  const intervalMs = Math.max(50, input.intervalMs);
  if (timeoutMs === 0) return;

  let stopped = false;
  void input.stopWhen?.finally(() => {
    stopped = true;
  });

  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < timeoutMs) {
    const endpoint = resolveServiceEndpoint(input.service, input.env, input.getConfig(input.service.id));
    if (endpoint) {
      try {
        const health = await input.fetchHealth(resolveServiceHealthUrl(input.service, endpoint), input.service);
        if (health.ok) return;
      } catch {
        // Readiness probes are internal while the service is starting. The UI
        // should see `starting`, not a transient health-probe fetch failure.
      }
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await delay(Math.min(intervalMs, remainingMs));
  }

  if (!stopped) {
    appendServiceLog(
      input.service.id,
      `[start] readiness check timed out after ${Math.round(timeoutMs / 1000)}s; service may still be starting\n`,
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function registerServiceLifecycleRoutes(
  app: FastifyInstance,
  options: { env?: NodeJS.ProcessEnv; fetchHealth?: FetchServiceHealth; lifecycle?: ServiceLifecycleRouteOptions } = {},
  lifecycleLock: ReturnType<typeof createServiceLifecycleLock> = createServiceLifecycleLock(),
): Promise<void> {
  const lifecycleTimeoutMs = options.lifecycle?.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const startupReadinessTimeoutMs =
    options.lifecycle?.startupReadinessTimeoutMs ??
    options.lifecycle?.startupGraceMs ??
    DEFAULT_STARTUP_READINESS_TIMEOUT_MS;
  const startupProbeIntervalMs = options.lifecycle?.startupProbeIntervalMs ?? DEFAULT_STARTUP_PROBE_INTERVAL_MS;
  const runner = options.lifecycle?.runScript ?? runServiceScript;
  const healthProbe = options.fetchHealth ?? fetchServiceHealth;
  const lookupPidsByPort = options.lifecycle?.findPidsByPort ?? findPidsByPort;
  const lookupProcessCommand = options.lifecycle?.readProcessCommand ?? readProcessCommand;
  const terminatePid =
    options.lifecycle?.killPid ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const serviceConfigStore = {
    get: options.lifecycle?.serviceConfig?.get ?? getServiceConfig,
    set: options.lifecycle?.serviceConfig?.set ?? setServiceConfig,
  };
  const lifecycleEnv = options.env ?? process.env;
  const getEffectiveConfig = (service: ServiceManifest) => {
    return resolveEffectiveServiceConfig(service, serviceConfigStore.get(service.id), lifecycleEnv);
  };
  const auditLog = options.lifecycle?.auditLog ?? getEventAuditLog();
  const { withLock } = lifecycleLock;
  const partitionServicePids = createServicePortPartitioner({
    lookupPidsByPort,
    lookupProcessCommand,
    log: app.log,
  });

  async function audit(input: {
    serviceId: string;
    action: ServiceLifecycleAction;
    operator: string;
    status: 'started' | 'completed' | 'failed' | 'rejected' | 'timed_out';
    code?: number | null;
    reason?: string;
  }): Promise<void> {
    try {
      await auditLog.append({ type: SERVICE_LIFECYCLE_AUDIT_TYPE, data: input });
    } catch (error) {
      app.log.warn(
        { err: error, serviceId: input.serviceId, action: input.action },
        'service lifecycle audit append failed',
      );
    }
  }

  await registerServiceLifecycleAuditRoutes(app, auditLog);

  async function runForeground(input: {
    serviceId: string;
    action: Extract<ServiceLifecycleAction, 'install' | 'uninstall'>;
    script: string;
    operator: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ ok: true; message: string } | { ok: false; error: string; output?: string }> {
    const scriptPath = resolveServiceScriptPath(input.script);
    if (!options.lifecycle?.runScript && !existsSync(scriptPath)) {
      return { ok: false, error: `${input.action} script not found: ${scriptPath}` };
    }
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'started' });
    const result = await runWithTimeout(runner, {
      serviceId: input.serviceId,
      action: input.action,
      scriptPath,
      env: input.env,
      timeoutMs: lifecycleTimeoutMs,
    });
    if (result.timedOut) {
      await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'timed_out' });
      return holdLifecycleLockUntil(
        { ok: false, error: `${input.action} script timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s` },
        getLifecycleRunSettlement(result),
      );
    }
    if (result.runnerError || result.code !== 0) {
      await audit({
        serviceId: input.serviceId,
        action: input.action,
        operator: input.operator,
        status: 'failed',
        code: result.code,
        reason: result.runnerError ? 'runner-error' : undefined,
      });
      return {
        ok: false,
        error: result.runnerError
          ? `${input.action} runner failed`
          : `${input.action} script failed${typeof result.code === 'number' ? ` (exit ${result.code})` : ''}`,
        output: result.output?.slice(-2000),
      };
    }
    await audit({ serviceId: input.serviceId, action: input.action, operator: input.operator, status: 'completed' });
    return { ok: true, message: `${input.action} completed` };
  }

  app.post<{ Params: { id: string }; Body: { model?: unknown; port?: unknown } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }
      const installScript = service.scripts?.install;
      if (!installScript) return { ok: true, message: `${service.name} has no install script` };

      const installPort =
        request.body?.port ??
        (await resolveSuggestedServicePort({
          service,
          config: getEffectiveConfig(service),
          env: lifecycleEnv,
          lookupPidsByPort,
        }));
      const envResult = buildLifecycleEnv(lifecycleEnv, service.id, request.body?.model, installPort);
      if (!envResult.ok) {
        reply.status(400);
        return { error: envResult.error };
      }

      // Persist the user-selected model + port so subsequent /start and
      // /uninstall spawns can read them from config rather than relying on
      // process.env state (which doesn't survive API restart).
      //   - Port: codex P2 3266466931
      //   - Model: codex P1 3279045004 — /start and /uninstall both read
      //     cfg.selectedModel via buildLifecycleEnv; without persisting at
      //     install time, post-restart start fails because *_MODEL env
      //     isn't set from process.env and config has no record either.
      // buildLifecycleEnv already validated model + port upstream of here.
      const persistPatch: { selectedModel?: string; port?: number } = {};
      if (typeof request.body?.model === 'string' && request.body.model.length > 0) {
        persistPatch.selectedModel = request.body.model;
      }
      if (typeof installPort === 'number') {
        persistPatch.port = installPort;
      }
      if (persistPatch.selectedModel !== undefined || persistPatch.port !== undefined) {
        serviceConfigStore.set(service.id, persistPatch);
      }

      return withLock(
        service.id,
        reply,
        async () => {
          const result = await runForeground({
            serviceId: service.id,
            action: 'install',
            script: installScript,
            operator,
            env: envResult.env,
          });
          if (!result.ok) {
            serviceConfigStore.set(service.id, { installed: false, enabled: false });
            reply.status(lifecycleFailureStatus(result.error));
          } else {
            const model = request.body?.model;
            const selectedModel = typeof model === 'string' && model.length > 0 ? model : undefined;
            serviceConfigStore.set(service.id, {
              installed: true,
              ...(selectedModel ? { selectedModel } : {}),
            });
          }
          return result;
        },
        { action: 'install' },
      );
    },
  );

  app.post<{ Params: { id: string } }>('/api/services/:id/uninstall', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    const uninstallScript = service.scripts?.uninstall;
    if (!uninstallScript) return { ok: true, message: `${service.name} has no uninstall script` };

    return withLock(
      service.id,
      reply,
      async () => {
        // Mirror /start: inject persisted selectedModel + port so uninstall
        // scripts that probe the install-time venv can find it (codex P1
        // 3265033601 / 3268690489). Fall back to bare env if persisted
        // config is invalid (uninstall should be tolerant of stale state).
        const cfg = getEffectiveConfig(service);
        const uninstallEnvResult = buildLifecycleEnv(lifecycleEnv, service.id, cfg?.selectedModel, cfg?.port);
        const uninstallEnv = uninstallEnvResult.ok ? uninstallEnvResult.env : { ...lifecycleEnv };
        const result = await runForeground({
          serviceId: service.id,
          action: 'uninstall',
          script: uninstallScript,
          operator,
          env: uninstallEnv,
        });
        if (!result.ok) {
          reply.status(lifecycleFailureStatus(result.error));
        } else {
          serviceConfigStore.set(service.id, { installed: false, enabled: false });
        }
        return result;
      },
      { action: 'uninstall' },
    );
  });

  async function startService(service: ServiceManifest, operator: string, reply: LifecycleReply) {
    const startScript = service.scripts?.start;
    if (!startScript) {
      reply.status(400);
      return { error: `Service "${service.id}" has no start script` };
    }
    // Probe the EFFECTIVE port: cfg.port if user installed on a custom
    // port, otherwise the manifest default. Without this, /start could
    // reject because the manifest's default port is busy (irrelevant —
    // we're not going to use it) or miss the actual port the script will
    // bind to (cfg.port). Codex P1 3268801298.
    const startEffectiveCfg = getEffectiveConfig(service);
    const startProbeService = { ...service, port: startEffectiveCfg?.port ?? service.port };
    const portProbe = await partitionServicePids(startProbeService);
    if (!portProbe.ok) {
      reply.status(503);
      await audit({ serviceId: service.id, action: 'start', operator, status: 'rejected', reason: portProbe.reason });
      return servicePortProbeUnavailableError(startProbeService.port);
    }
    if (portProbe.foreign.length > 0) {
      reply.status(409);
      await audit({
        serviceId: service.id,
        action: 'start',
        operator,
        status: 'rejected',
        reason: 'foreign-port-owner',
      });
      return { error: `Service port ${startProbeService.port} is already owned by another process` };
    }
    if (portProbe.owned.length > 0) {
      serviceConfigStore.set(service.id, { installed: true, enabled: true });
      await audit({
        serviceId: service.id,
        action: 'start',
        operator,
        status: 'completed',
        reason: 'already-running',
      });
      return { ok: true, message: `${service.name} is already running`, pids: portProbe.owned };
    }

    return withLock(
      service.id,
      reply,
      async () => {
        const scriptPath = resolveServiceScriptPath(startScript);
        if (!options.lifecycle?.runScript && !existsSync(scriptPath)) {
          reply.status(400);
          return { error: `Start script not found: ${scriptPath}` };
        }
        // Inject persisted selectedModel + port from serviceConfig so the
        // start script sees the same env that install did. Without this,
        // services with required MODEL_ENV_VARS (whisper-stt, mlx-tts,
        // embedding-model, llm-postprocess) fail immediately at start if
        // the operator hadn't pre-defined WHISPER_MODEL / etc. in .env —
        // install succeeded but start can't read the choice. Codex P1
        // 3265033601 / 3268690489. (Supersedes upstream's inline
        // model-only injection — buildLifecycleEnv handles model + port +
        // strict validation in one call.)
        const cfg = getEffectiveConfig(service);
        const startEnvResult = buildLifecycleEnv(lifecycleEnv, service.id, cfg?.selectedModel, cfg?.port);
        if (!startEnvResult.ok) {
          reply.status(500);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'failed',
            reason: 'invalid-persisted-config',
          });
          return { ok: false, error: `Invalid persisted service config: ${startEnvResult.error}` };
        }
        await audit({ serviceId: service.id, action: 'start', operator, status: 'started' });
        const result = await runWithTimeout(runner, {
          serviceId: service.id,
          action: 'start',
          scriptPath,
          env: startEnvResult.env,
          detached: true,
          timeoutMs: lifecycleTimeoutMs,
        });
        if (result.timedOut) {
          reply.status(408);
          await audit({ serviceId: service.id, action: 'start', operator, status: 'timed_out' });
          return holdLifecycleLockUntil(
            { ok: false, error: `start script timed out after ${Math.round(lifecycleTimeoutMs / 1000)}s` },
            getLifecycleRunSettlement(result),
          );
        }
        if (result.runnerError || (typeof result.code === 'number' && result.code !== 0)) {
          reply.status(result.runnerError ? 502 : 422);
          await audit({
            serviceId: service.id,
            action: 'start',
            operator,
            status: 'failed',
            code: result.code,
            reason: result.runnerError ? 'runner-error' : undefined,
          });
          return {
            ok: false,
            error: result.runnerError ? 'start runner failed' : `start script failed (exit ${result.code})`,
            output: result.output?.slice(-2000),
          };
        }
        serviceConfigStore.set(service.id, { installed: true, enabled: true });
        await audit({ serviceId: service.id, action: 'start', operator, status: 'completed', code: result.code });
        const success = { ok: true, message: `${service.name} start initiated`, pid: result.pid };
        const settlement = settleQuietly(result.settlement);
        const readiness = waitForServiceReadiness({
          service,
          env: startEnvResult.env,
          getConfig: (id) => {
            const target = getServiceManifest(id);
            return target ? getEffectiveConfig(target) : serviceConfigStore.get(id);
          },
          fetchHealth: healthProbe,
          timeoutMs: startupReadinessTimeoutMs,
          intervalMs: startupProbeIntervalMs,
          stopWhen: settlement,
        });
        const releaseWhen = settlement ? Promise.race([settlement, readiness]) : readiness;
        return holdStartupGrace(success, startupReadinessTimeoutMs, releaseWhen);
      },
      { action: 'start' },
    );
  }

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return startService(service, operator, reply);
  });

  async function stopDisabledOwnedService(service: ServiceManifest): Promise<void> {
    const cfg = getEffectiveConfig(service);
    const probeService = { ...service, port: cfg?.port ?? service.port };
    const portProbe = await partitionServicePids(probeService);
    if (!portProbe.ok) {
      app.log.warn(
        { serviceId: service.id, reason: portProbe.reason },
        'service startup reconciler could not probe disabled service',
      );
      return;
    }
    if (portProbe.foreign.length > 0) {
      app.log.warn(
        { serviceId: service.id, pids: portProbe.foreign },
        'service startup reconciler found foreign listener on disabled service port',
      );
      return;
    }
    if (portProbe.owned.length === 0) return;

    const stopped: number[] = [];
    const failed: number[] = [];
    for (const pid of portProbe.owned) {
      try {
        terminatePid(pid, 'SIGTERM');
        stopped.push(pid);
      } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) continue;
        failed.push(pid);
        app.log.warn({ err: error, serviceId: service.id, pid }, 'service startup reconciler terminate failed');
      }
    }
    if (stopped.length > 0) {
      appendServiceLog(service.id, `[startup-reconciler] stopped disabled orphan process(es): ${stopped.join(', ')}\n`);
    }
    await audit({
      serviceId: service.id,
      action: 'stop',
      operator: STARTUP_RECONCILER_OPERATOR,
      status: failed.length > 0 ? 'failed' : 'completed',
      reason: 'disabled-startup-cleanup',
    });
  }

  async function reconcileServiceStartup(): Promise<void> {
    const candidates = SERVICE_MANIFESTS.filter((service) => service.scripts?.start);
    if (candidates.length === 0) return;

    app.log.info({ count: candidates.length }, 'service startup reconciler checking service state');
    await Promise.all(
      candidates.map(async (service) => {
        const cfg = getEffectiveConfig(service);
        if (cfg?.enabled === false) {
          await stopDisabledOwnedService(service);
          return;
        }
        if (!(cfg?.enabled && cfg.installed !== false)) return;
        const reply = createInternalReply();
        const result = await startService(service, STARTUP_RECONCILER_OPERATOR, reply);
        if ((reply.statusCode ?? 200) >= 400) {
          app.log.warn(
            { serviceId: service.id, statusCode: reply.statusCode, result },
            'service startup reconciler failed',
          );
        }
      }),
    );
  }

  if (options.lifecycle?.autoStartEnabled) {
    app.addHook('onReady', async () => {
      setImmediate(() => {
        void reconcileServiceStartup().catch((error) => {
          app.log.warn({ err: error }, 'service startup reconciler failed');
        });
      });
    });
  }

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return withLock(
      service.id,
      reply,
      async () => {
        // Probe the EFFECTIVE port (cfg.port ?? service.port) so /stop
        // finds the actually-listening sidecar after a custom-port
        // install (codex P1 3268801298).
        const stopEffectiveCfg = getEffectiveConfig(service);
        const stopProbeService = { ...service, port: stopEffectiveCfg?.port ?? service.port };
        const portProbe = await partitionServicePids(stopProbeService);
        if (!portProbe.ok) {
          reply.status(503);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'rejected',
            reason: portProbe.reason,
          });
          return servicePortProbeUnavailableError(stopProbeService.port);
        }
        if (portProbe.foreign.length > 0) {
          reply.status(409);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'rejected',
            reason: 'foreign-port-owner',
          });
          return { error: `Service port ${stopProbeService.port} is owned by another process` };
        }
        const stopped: number[] = [];
        const failed: number[] = [];
        for (const pid of portProbe.owned) {
          try {
            terminatePid(pid, 'SIGTERM');
            stopped.push(pid);
          } catch (error) {
            if (hasErrorCode(error, 'ESRCH')) continue;
            failed.push(pid);
            app.log.warn({ err: error, serviceId: service.id, pid }, 'service stop terminate failed');
          }
        }
        if (failed.length > 0) {
          reply.status(502);
          await audit({
            serviceId: service.id,
            action: 'stop',
            operator,
            status: 'failed',
            reason: 'terminate-failed',
          });
          return {
            ok: false,
            error: `${service.name} stop failed for ${failed.length} process(es)`,
            stopped,
            failed,
          };
        }
        serviceConfigStore.set(service.id, { enabled: false });
        await audit({ serviceId: service.id, action: 'stop', operator, status: 'completed' });
        return { ok: true, message: `${service.name} stopped (${stopped.length} process(es))`, stopped };
      },
      { action: 'stop' },
    );
  });

  app.post<{ Params: { id: string }; Body: { enabled?: unknown; model?: unknown } }>(
    '/api/services/:id/toggle',
    async (request, reply) => {
      const operator = requireLifecycleOwner(request, reply);
      if (!operator) return lifecycleOwnerError(reply);
      const service = getServiceManifest(request.params.id);
      if (!service) {
        reply.status(404);
        return { error: `Service "${request.params.id}" not found` };
      }
      if (typeof request.body?.enabled !== 'boolean') {
        reply.status(400);
        return { error: 'Invalid body: enabled must be boolean' };
      }
      const enabled = request.body.enabled;
      return withLock(
        service.id,
        reply,
        async () => {
          const patch: { enabled: boolean; selectedModel?: string } = { enabled };
          const model = request.body?.model;
          const envResult = buildLifecycleEnv({}, service.id, model);
          if (!envResult.ok) {
            reply.status(400);
            return { error: envResult.error };
          }
          if (typeof model === 'string' && model.length > 0) {
            patch.selectedModel = model;
          }
          const config = serviceConfigStore.set(service.id, patch);
          await audit({ serviceId: service.id, action: 'toggle', operator, status: 'completed' });
          return { ok: true, config };
        },
        { action: 'toggle' },
      );
    },
  );

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);
    const service = getServiceManifest(request.params.id);
    if (!service) {
      reply.status(404);
      return { error: `Service "${request.params.id}" not found` };
    }
    return { serviceId: service.id, lines: readServiceLogTail(service.id) };
  });
}
