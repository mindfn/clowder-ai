import { spawn } from 'node:child_process';
import { closeSync, existsSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getEnvironmentProfile } from '../domains/services/environment-detector.js';
import {
  checkProcessByPattern,
  findPidsByPort,
  isServiceProcess,
  winTaskKill,
} from '../domains/services/process-utils.js';
import { buildRecommendation } from '../domains/services/recommendation-matrix.js';
import { getServiceConfig, setServiceConfig } from '../domains/services/service-config.js';
import {
  appendLog,
  isValidModelId,
  openLogFd,
  readLogTail,
  resolveScriptPath,
  resolveSpawnCommand,
} from '../domains/services/service-logs.js';
import { MODEL_ENV_VARS, PORT_ENV_VARS } from '../domains/services/service-manifest.js';
import {
  allocateAvailablePort,
  clearServicePid,
  getAllServiceStates,
  getKnownServices,
  getServiceById,
  getServicePid,
  getServiceState,
  resolveServiceEndpoint,
  resolveServicePort,
  setServicePid,
} from '../domains/services/service-registry.js';
import { resolveUserId } from '../utils/request-identity.js';

function checkServiceOwner(request: Parameters<typeof resolveUserId>[0]): { status: 401 | 403; error: string } | null {
  const userId = resolveUserId(request);
  if (!userId) return { status: 401, error: 'Authentication required' };
  const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
  if (ownerId && userId !== ownerId) return { status: 403, error: 'Only the owner can manage services' };
  return null;
}

function checkPlatformSupport(manifest: { supportedPlatforms?: string[]; name: string }): string | null {
  if (!manifest.supportedPlatforms) return null;
  if (manifest.supportedPlatforms.includes(process.platform)) return null;
  const supported = manifest.supportedPlatforms.join(', ');
  return `${manifest.name} requires ${supported} (current: ${process.platform}). MLX-based services are Apple Silicon only.`;
}

/**
 * Pattern-match install stdout/stderr to give the user an actionable next step.
 * Pip + HuggingFace + Piper download failures usually have stable error markers
 * that map to a concrete remediation (mirror env var, manual model placement).
 * Returns null when no known pattern matches.
 */
function detectInstallFailureHint(output: string): string | null {
  const lower = output.toLowerCase();

  // Pip can't reach PyPI / wheel index
  if (
    lower.includes('connectionerror') ||
    lower.includes('connecttimeouterror') ||
    lower.includes('connect timeout') ||
    lower.includes('temporary failure in name resolution') ||
    lower.includes('proxyerror') ||
    lower.includes('failed to establish a new connection')
  ) {
    return [
      '网络连接失败。可能的解决方法：',
      '· 国内用户：在 .env 设置 HF_ENDPOINT=https://hf-mirror.com（HuggingFace 镜像）+ PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple',
      '· 内网环境：设置 PIP_INDEX_URL=<内网 PyPI 镜像>',
      '· 离线环境：手动准备模型后重试 install（详见 docs/services-offline-install.md）',
    ].join('\n');
  }

  // Pip can't find a wheel for the current platform / Python version
  if (lower.includes('could not find a version') || lower.includes('no matching distribution')) {
    return [
      'pip 找不到匹配的 wheel。可能的原因：',
      '· 当前架构（ARM / x86）没有预编译 wheel — 详见 docs/services-offline-install.md "平台兼容性"',
      '· 内网 PyPI 镜像没同步该包 — 设置 PIP_EXTRA_INDEX_URL=https://pypi.org/simple 回落到官方源',
    ].join('\n');
  }

  // HuggingFace snapshot_download fails (covers HFHubHTTPError, RepositoryNotFoundError, etc.)
  if (
    lower.includes('repositorynotfound') ||
    lower.includes('hfhubconnectionerror') ||
    lower.includes('hfvalidationerror') ||
    lower.includes('failed to download model') ||
    (lower.includes('huggingface.co') && lower.includes('error'))
  ) {
    return [
      'HuggingFace 模型下载失败。可能的解决方法：',
      '· 国内用户：在 .env 设置 HF_ENDPOINT=https://hf-mirror.com',
      '· 离线环境：手动下载模型到 ~/.cache/huggingface/hub/，然后重试 install 会自动识别（详见 docs/services-offline-install.md）',
    ].join('\n');
  }

  // Piper voice download (custom curl-based, not huggingface_hub)
  if (lower.includes('failed to download') && (lower.includes('.onnx') || lower.includes('piper'))) {
    return [
      'Piper voice 模型下载失败。可手动下载到 ~/.cat-cafe/piper-models/<voice>.onnx + .onnx.json，重试 install 会跳过下载。',
      '镜像源：https://huggingface.co/rhasspy/piper-voices/tree/main (国内用 https://hf-mirror.com/rhasspy/piper-voices/tree/main)',
    ].join('\n');
  }

  return null;
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/services', async () => {
    const states = await getAllServiceStates();
    return { services: states };
  });

  app.get('/api/services/endpoints', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const endpoints: Record<string, string | null> = {};
    for (const manifest of getKnownServices()) {
      endpoints[manifest.id] = resolveServiceEndpoint(manifest);
    }
    return { endpoints };
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/health', async (request, reply) => {
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const state = await getServiceState(manifest);
    return state;
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/install-preview', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const profile = getEnvironmentProfile(true);
    const recommendation = buildRecommendation(id, profile);
    // Suggest a port for the install dialog to pre-fill. Honors any port
    // already saved in services.json (legacy fixed-port behaviour), otherwise
    // scans for the first free port starting at the manifest default.
    const cfg = getServiceConfig(id);
    const defaultPort = manifest.port ?? 9000;
    const suggestedPort = cfg.port ?? (await allocateAvailablePort(defaultPort));
    return { profile, recommendation, suggestedPort };
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/start', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.start) {
      reply.status(400);
      return { error: `Service "${id}" has no start script` };
    }
    const platformErr = checkPlatformSupport(manifest);
    if (platformErr) {
      reply.status(422);
      return { error: platformErr };
    }

    const current = await getServiceState(manifest);
    if (current.status === 'running') {
      return { ok: true, message: `${manifest.name} is already running` };
    }

    if (manifest.port) {
      const existingProcess = await checkProcessByPattern(manifest.scripts.start);
      if (existingProcess) {
        return { ok: true, message: `${manifest.name} is still starting (existing process found)` };
      }
    }

    const scriptPath = resolveScriptPath(manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Start script not found: ${scriptPath}` };
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const cfg = getServiceConfig(id);
    if (cfg.selectedModel && isValidModelId(cfg.selectedModel)) {
      const envKey = MODEL_ENV_VARS[id];
      if (envKey) env[envKey] = cfg.selectedModel;
    }
    // Server scripts bind to *_PORT env var when set, else fall back to a
    // hard-coded default. Pipe the persisted port through.
    const cfgPort = resolveServicePort(manifest);
    if (cfgPort) {
      const portEnv = PORT_ENV_VARS[id];
      if (portEnv) env[portEnv] = String(cfgPort);
    }

    const logFd = openLogFd(id);
    try {
      const { command: spawnCmd, args: spawnArgs } = resolveSpawnCommand(manifest.scripts.start);
      const child = spawn(spawnCmd, spawnArgs, {
        detached: process.platform !== 'win32',
        stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
        env,
      });
      child.on('error', () => {});
      if (!child.pid) {
        reply.status(500);
        return { error: `Failed to spawn start script for ${manifest.name}` };
      }

      const earlyExit = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.unref();
          resolve(null);
        }, 2000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      if (earlyExit !== null) {
        if (earlyExit === 0 && manifest.port) {
          await new Promise((r) => setTimeout(r, 1500));
          const healthState = await getServiceState(manifest);
          if (healthState.status === 'running' || healthState.status === 'starting') {
            setServicePid(id, child.pid);
            return { ok: true, message: `${manifest.name} start initiated` };
          }
        }
        const logs = readLogTail(id, 20);
        request.log.error(
          { serviceId: id, exitCode: earlyExit, logs },
          `service start failed: ${manifest.name} exited immediately`,
        );
        reply.status(500);
        return { error: `${manifest.name} exited immediately (code ${earlyExit})`, logs };
      }
      setServicePid(id, child.pid);
      return { ok: true, message: `${manifest.name} start initiated (pid: ${child.pid})` };
    } catch {
      reply.status(500);
      return { error: `Failed to start ${manifest.name}: spawn error` };
    } finally {
      if (logFd != null) closeSync(logFd);
    }
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/stop', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }

    // 1) Try stored PID (most reliable — recorded at start time)
    const storedPid = getServicePid(id);
    if (storedPid) {
      try {
        if (process.platform === 'win32') {
          winTaskKill(storedPid);
        } else {
          process.kill(-storedPid, 'SIGTERM');
        }
      } catch {
        /* already gone */
      }
      clearServicePid(id);
      return { ok: true, message: `${manifest.name} stopped (pid ${storedPid})` };
    }

    // 2) Try stop script if defined
    if (manifest.scripts.stop) {
      const scriptPath = resolveScriptPath(manifest.scripts.stop);
      if (existsSync(scriptPath)) {
        try {
          const { command: stopCmd, args: stopArgs } = resolveSpawnCommand(manifest.scripts.stop);
          const child = spawn(stopCmd, stopArgs, { stdio: 'ignore' });
          const code = await new Promise<number | null>((res, rej) => {
            child.on('error', rej);
            child.on('close', (c) => res(c));
          });
          if (code !== 0) {
            reply.status(500);
            return { ok: false, error: `Stop script for ${manifest.name} exited with code ${code}` };
          }
          return { ok: true, message: `${manifest.name} stopped via script` };
        } catch {
          reply.status(500);
          return { ok: false, error: `Failed to run stop script for ${manifest.name}` };
        }
      }
    }

    // 3) Fallback: port-based kill
    if (!manifest.port) {
      reply.status(400);
      return { error: `Service "${id}" has no stored PID, stop script, or port` };
    }

    try {
      const candidatePids = await findPidsByPort(manifest.port);
      const killed: number[] = [];
      for (const pid of candidatePids) {
        if (!isServiceProcess(pid, manifest)) continue;
        const ok =
          process.platform === 'win32'
            ? winTaskKill(pid)
            : (() => {
                try {
                  process.kill(pid, 'SIGTERM');
                  return true;
                } catch {
                  return false;
                }
              })();
        if (ok) killed.push(pid);
      }
      if (killed.length === 0) {
        request.log.warn({ serviceId: id, port: manifest.port, candidatePids }, 'stop: no matching processes killed');
      }
      return { ok: true, message: `${manifest.name} stopped (${killed.length} process(es))` };
    } catch {
      reply.status(500);
      return { ok: false, error: 'Failed to stop service' };
    }
  });

  app.post<{ Params: { id: string }; Body: { model?: string; port?: number } }>(
    '/api/services/:id/install',
    async (request, reply) => {
      const ownerErr = checkServiceOwner(request);
      if (ownerErr) {
        reply.status(ownerErr.status);
        return { error: ownerErr.error };
      }
      const { id } = request.params;
      const body = (request.body ?? {}) as { model?: string; port?: number };
      const manifest = getServiceById(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Service "${id}" not found` };
      }
      if (!manifest.scripts.install) {
        return { ok: true, message: `${manifest.name} has no install script (dependencies managed externally)` };
      }

      if (body.model && !isValidModelId(body.model)) {
        reply.status(400);
        return { error: 'Invalid model ID format (expected: org/model-name)' };
      }

      const platformErr = checkPlatformSupport(manifest);
      if (platformErr) {
        reply.status(422);
        return { error: platformErr };
      }

      const previewProfile = getEnvironmentProfile();
      const previewRec = buildRecommendation(id, previewProfile);
      if (previewRec.unsupported) {
        reply.status(422);
        return {
          ok: false,
          error: previewRec.unsupported.reason,
          unsupported: previewRec.unsupported,
        };
      }

      const current = await getServiceState(manifest);
      if (current.status === 'installing') {
        return { ok: true, message: `${manifest.name} is already installing` };
      }

      const scriptPath = resolveScriptPath(manifest.scripts.install);
      if (!existsSync(scriptPath)) {
        reply.status(400);
        return { error: `Install script not found: ${scriptPath}` };
      }

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (body.model) {
        const envKey = MODEL_ENV_VARS[id];
        if (envKey) env[envKey] = body.model;
      }

      // Decide on the port this service will bind to:
      //   1. body.port (user explicitly chose in the install dialog)
      //   2. getServiceConfig(id).port (already saved from a prior install)
      //   3. allocateAvailablePort(manifest.port) (auto — first free port)
      // The chosen port is persisted to services.json so subsequent
      // start / autostart / status routes use the same value.
      let resolvedPort: number | undefined = body.port;
      if (typeof resolvedPort === 'number' && (resolvedPort < 1 || resolvedPort > 65535)) {
        reply.status(400);
        return { error: 'Invalid port (expected 1..65535)' };
      }
      if (!resolvedPort) {
        const existing = getServiceConfig(id).port;
        resolvedPort = existing ?? (await allocateAvailablePort(manifest.port ?? 9000));
      }
      setServiceConfig(id, { port: resolvedPort });
      const portEnv = PORT_ENV_VARS[id];
      if (portEnv) env[portEnv] = String(resolvedPort);

      // Always run uninstall first to guarantee a clean venv. The uninstall
      // script is idempotent (rm -rf of a non-existent venv is fine), so this
      // is safe for first-time installs and corrects any state left behind by
      // a failed previous attempt (e.g. partial pip install, locked .pyd).
      if (manifest.scripts.uninstall) {
        const uninstallPath = resolveScriptPath(manifest.scripts.uninstall);
        if (existsSync(uninstallPath)) {
          const { command: uCmd, args: uArgs } = resolveSpawnCommand(manifest.scripts.uninstall);
          await new Promise<void>((resolve) => {
            const child = spawn(uCmd, uArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout?.on('data', (d: Buffer) => appendLog(id, d.toString()));
            child.stderr?.on('data', (d: Buffer) => appendLog(id, d.toString()));
            child.on('error', (err) => {
              request.log.warn({ serviceId: id, err: err.message }, 'pre-install uninstall errored (continuing)');
              resolve();
            });
            child.on('close', (code) => {
              if (code !== 0) {
                request.log.warn(
                  { serviceId: id, exitCode: code },
                  'pre-install uninstall exited non-zero (continuing — install will rebuild)',
                );
              }
              resolve();
            });
          });
        }
      }

      try {
        const { command: installCmd, args: installArgs } = resolveSpawnCommand(manifest.scripts.install);
        const child = spawn(installCmd, installArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
        let output = '';
        const MAX_OUTPUT = 8192;
        const appendOutput = (s: string) => {
          output += s;
          if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
        };
        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString();
          appendOutput(s);
          appendLog(id, s);
        });
        child.stderr?.on('data', (d: Buffer) => {
          const s = d.toString();
          appendOutput(s);
          appendLog(id, s);
        });
        const code = await new Promise<number | null>((res, rej) => {
          child.on('error', rej);
          child.on('close', (c) => res(c));
        });

        if (code !== 0) {
          setServiceConfig(id, { installStatus: 'failed' });
          const troubleshootHint = detectInstallFailureHint(output);
          request.log.error(
            { serviceId: id, exitCode: code, output: output.slice(-2000) },
            `service install failed: ${manifest.name}`,
          );
          reply.status(422);
          return {
            ok: false,
            error: `Install failed (exit ${code})`,
            output: output.slice(-2000),
            troubleshootHint,
          };
        }

        setServiceConfig(id, { installStatus: 'installed' });

        if (manifest.scripts.start && getServiceConfig(id).enabled) {
          const startScript = resolveScriptPath(manifest.scripts.start);
          if (existsSync(startScript)) {
            const startEnv: Record<string, string> = { ...process.env } as Record<string, string>;
            const cfg = getServiceConfig(id);
            if (cfg.selectedModel && isValidModelId(cfg.selectedModel)) {
              const ek = MODEL_ENV_VARS[id];
              if (ek) startEnv[ek] = cfg.selectedModel;
            }
            if (cfg.port) {
              const pk = PORT_ENV_VARS[id];
              if (pk) startEnv[pk] = String(cfg.port);
            }
            const startFd = openLogFd(id);
            const { command: autoStartCmd, args: autoStartArgs } = resolveSpawnCommand(manifest.scripts.start);
            const startChild = spawn(autoStartCmd, autoStartArgs, {
              detached: process.platform !== 'win32',
              stdio: startFd != null ? ['ignore', startFd, startFd] : 'ignore',
              env: startEnv,
            });
            startChild.on('error', () => {});
            if (startChild.pid) setServicePid(id, startChild.pid);
            startChild.unref();
            if (startFd != null) closeSync(startFd);
          }
        }

        return { ok: true, message: `${manifest.name} installed successfully` };
      } catch {
        reply.status(500);
        return { ok: false, error: `Failed to run install script for ${manifest.name}` };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/services/:id/uninstall', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    if (!manifest.scripts.uninstall) {
      return { ok: true, message: `${manifest.name} has no uninstall script` };
    }

    const scriptPath = resolveScriptPath(manifest.scripts.uninstall);
    if (!existsSync(scriptPath)) {
      reply.status(400);
      return { error: `Uninstall script not found: ${scriptPath}` };
    }

    try {
      const { command: uninstallCmd, args: uninstallArgs } = resolveSpawnCommand(manifest.scripts.uninstall);
      const child = spawn(uninstallCmd, uninstallArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '';
      const MAX_OUTPUT = 8192;
      const appendOutput = (s: string) => {
        output += s;
        if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
      };
      child.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        appendOutput(s);
        appendLog(id, s);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString();
        appendOutput(s);
        appendLog(id, s);
      });
      const code = await new Promise<number | null>((res, rej) => {
        child.on('error', rej);
        child.on('close', (c) => res(c));
      });

      if (code !== 0) {
        request.log.error(
          { serviceId: id, exitCode: code, output: output.slice(-2000) },
          `service uninstall failed: ${manifest.name}`,
        );
        reply.status(422);
        return { ok: false, error: `Uninstall failed (exit ${code})`, output: output.slice(-2000) };
      }
      setServiceConfig(id, { installStatus: 'none', enabled: false });
      return { ok: true, message: `${manifest.name} uninstalled successfully` };
    } catch {
      reply.status(500);
      return { ok: false, error: `Failed to run uninstall script for ${manifest.name}` };
    }
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/logs', async (request, reply) => {
    const ownerErr = checkServiceOwner(request);
    if (ownerErr) {
      reply.status(ownerErr.status);
      return { error: ownerErr.error };
    }
    const { id } = request.params;
    const manifest = getServiceById(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Service "${id}" not found` };
    }
    const lines = readLogTail(id);
    return { serviceId: id, lines };
  });

  app.post<{ Params: { id: string }; Body: { enabled: boolean; model?: string } }>(
    '/api/services/:id/toggle',
    async (request, reply) => {
      const ownerErr = checkServiceOwner(request);
      if (ownerErr) {
        reply.status(ownerErr.status);
        return { error: ownerErr.error };
      }
      const { id } = request.params;
      const toggleSchema = z.object({ enabled: z.boolean(), model: z.string().optional() });
      const parsed = toggleSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parsed.error.issues };
      }
      const body = parsed.data;
      const manifest = getServiceById(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Service "${id}" not found` };
      }

      const patch: { enabled: boolean; selectedModel?: string } = { enabled: body.enabled };
      if (body.model) {
        if (!isValidModelId(body.model)) {
          reply.status(400);
          return { error: 'Invalid model ID format (expected: org/model-name)' };
        }
        patch.selectedModel = body.model;
      }
      setServiceConfig(id, patch);

      return { ok: true, config: getServiceConfig(id) };
    },
  );
};
