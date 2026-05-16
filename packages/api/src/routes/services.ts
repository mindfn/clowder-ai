import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { fireServiceEvent } from '../domains/services/service-hooks.js';
import {
  appendLog,
  isValidModelId,
  readLogTail,
  resolveRepoRoot,
  resolveScriptPath,
  resolveSpawnCommand,
  wireUpSidecarReadyListener,
} from '../domains/services/service-logs.js';
import { MODEL_ENV_VARS, PORT_ENV_VARS } from '../domains/services/service-manifest.js';
import { resolveSelectedModel } from '../domains/services/service-model-resolver.js';
import {
  allocateAvailablePort,
  clearServicePid,
  getAllServiceStates,
  getKnownServices,
  getServiceById,
  getServicePid,
  getServiceState,
  probeServiceHealth,
  resolveServiceEndpoint,
  resolveServicePort,
  setInstalling,
  setServicePid,
  setStarting,
  setUninstalling,
  tryAcquireInstallLock,
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
 * Normalize invalid proxy URL schemes in the child env. VPN clients like
 * clash / v2ray frequently emit ALL_PROXY=socks://... but httpx (used by
 * huggingface_hub, used by every service sidecar) rejects 'socks' — it
 * wants 'socks5' or 'socks5h'. Same fix prereq-check.sh does, but
 * applied here so the API also normalizes for the child without relying
 * on each shell script to do it.
 */
function normalizeProxyEnv(env: Record<string, string>): void {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const val = env[key];
    if (val && val.startsWith('socks://')) {
      env[key] = `socks5${val.slice('socks'.length)}`;
    }
  }
}

// resolveSelectedModel moved to ./domains/services/service-model-resolver.ts
// so service-autostart can reuse the exact same priority chain (body.model >
// cfg.selectedModel > matrix recommendation default). The legacy
// service-autostart only honored cfg.selectedModel — that bug is fixed by
// the shared helper now imported above.

/**
 * After a sidecar spawn, poll its health probe until it reports 'running',
 * then fire its 'started' event so registered hooks (e.g. embed catch-up)
 * run. Mirrors service-autostart's watchAndAnnounceReady contract —
 * critically, we only treat 'running' as terminal here, NOT 'stopped':
 * a freshly-spawned sidecar's health endpoint returns ECONNREFUSED for
 * the first few seconds while uvicorn is binding the port, and
 * waitUntilHealthSettles would (incorrectly) classify that as a terminal
 * 'stopped' and return immediately, skipping the fire.
 *
 * 5 min total budget, 5 s between probes — same as the autostart watcher.
 * Always clears the in-flight setStarting flag in finally.
 */
async function watchForRunningAndFire(
  id: string,
  manifest: import('../domains/services/service-manifest.js').ServiceManifest,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  isAlreadyFired?: () => boolean,
): Promise<void> {
  const POLL_INTERVAL_MS = 5_000;
  const MAX_ATTEMPTS = 60; // 5 min
  // Use the RAW probe (probeServiceHealth) instead of getServiceState
  // here. getServiceState rewrites every non-running probe to 'starting'
  // whenever startingServices is set (which the /start endpoint set
  // before spawning), so if the sidecar crashed or never bound, this
  // loop would see 'starting' forever and only exit after the 5-min
  // timeout. With the raw probe we can observe true 'stopped' / 'error'
  // and bail early on definitive failure — but we tolerate a small
  // window of 'stopped' (uvicorn binding the port can ECONNREFUSED for
  // the first few seconds), so we only treat it as terminal after
  // STOPPED_TERMINAL_COUNT consecutive stopped/error probes.
  const STOPPED_TERMINAL_COUNT = 3; // 15s of consecutive failure → bail
  let stoppedStreak = 0;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      // If the push-based ready marker already won the race, the watcher
      // role is done. Without this guard the watcher would re-fire
      // 'started' and run every always-on hook (e.g. embedding catch-up
      // registered with unregisterOnSuccess=false) a second time
      // concurrently with the marker-path dispatch (codex P2 3251557957).
      if (isAlreadyFired?.()) return;
      try {
        const probe = await probeServiceHealth(manifest);
        if (probe.status === 'running') {
          if (isAlreadyFired?.()) return; // re-check after async probe
          log.info(`[services] /start ${id} watcher: healthy after ${((attempt + 1) * POLL_INTERVAL_MS) / 1000}s`);
          await fireServiceEvent(id, 'started');
          log.info(`[services] /start ${id} fired 'started' event`);
          return;
        }
        if (probe.status === 'stopped' || probe.status === 'error') {
          stoppedStreak += 1;
          if (stoppedStreak >= STOPPED_TERMINAL_COUNT) {
            log.warn(
              `[services] /start ${id} watcher: probe='${probe.status}' for ${stoppedStreak} consecutive checks (${(stoppedStreak * POLL_INTERVAL_MS) / 1000}s) — sidecar appears not to have come up, bailing early`,
            );
            return;
          }
        } else {
          // 'starting' (sidecar /health returned status='loading') or
          // 'unknown' — reset the streak; sidecar is responding,
          // just not ready yet.
          stoppedStreak = 0;
        }
      } catch {
        /* transient probe failure — try again next tick, don't count as stopped */
      }
    }
    log.warn(
      `[services] /start ${id} watcher: did not become healthy within ${(MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
    );
  } finally {
    setStarting(id, false);
  }
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

  // Serve the offline-install guide from the local repo so the help link in
  // InstallPreviewModal works in offline / air-gapped environments. The HTML
  // is pre-rendered and checked in (docs/services-offline-install.html);
  // regenerate with `pnpm -w build-docs` (or the one-shot script in commit
  // history) when the .md source changes. Keeps marked off the production
  // dependency list — doc edits are infrequent enough that manual regen is
  // cheaper than a runtime parser.
  app.get('/api/services/docs/offline-install', async (_request, reply) => {
    const htmlPath = resolve(resolveRepoRoot(), 'docs/services-offline-install.html');
    if (!existsSync(htmlPath)) {
      reply.status(404);
      return { error: 'docs/services-offline-install.html not found — regenerate from the .md source' };
    }
    reply.header('cache-control', 'no-cache');
    reply.type('text/html; charset=utf-8');
    return readFileSync(htmlPath, 'utf-8');
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
    // Suggest a port for the install dialog to pre-fill. Priority chain
    // mirrors the install handler (cf. commit 3480a27f), so confirming
    // the modal never silently rewrites operator-configured ports
    // (codex P2 3250305307):
    //   1. services.json cfg.port    — console's previous user intent
    //   2. env port (EMBED_PORT etc.) — operator's .env override
    //   3. allocateAvailablePort(manifest.port ?? 9000)
    const cfg = getServiceConfig(id);
    let suggestedPort: number | undefined = cfg.port;
    if (!suggestedPort) {
      // Scan manifest.configVars first, then PORT_ENV_VARS[id] as a final
      // env source — mirrors the install handler so opening the preview
      // and clicking confirm doesn't silently rewrite operator-configured
      // ports for services whose manifest doesn't list the dedicated
      // *_PORT (e.g. llm-postprocess, whisper-stt, mlx-tts). Codex P2
      // 3252138418.
      const envCandidates: string[] = [...manifest.configVars];
      const dedicatedPortEnv = PORT_ENV_VARS[id];
      if (dedicatedPortEnv && !envCandidates.includes(dedicatedPortEnv)) {
        envCandidates.push(dedicatedPortEnv);
      }
      for (const envVar of envCandidates) {
        const val = process.env[envVar];
        if (!val || val.startsWith('http')) continue;
        const trimmed = val.trim();
        if (!/^\d+$/.test(trimmed)) continue;
        const n = Number.parseInt(trimmed, 10);
        if (Number.isFinite(n) && n > 0 && n <= 65535) {
          suggestedPort = n;
          break;
        }
      }
    }
    if (!suggestedPort) {
      suggestedPort = await allocateAvailablePort(manifest.port ?? 9000);
    }
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
      // Re-fire 'started' so consumers (e.g. evidence embed catch-up) still
      // run their initial hook even when the sidecar was already healthy.
      request.log.info(`[services] /start ${id} → already running, firing 'started' event`);
      void fireServiceEvent(id, 'started');
      return { ok: true, message: `${manifest.name} is already running`, state: current };
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
    normalizeProxyEnv(env);
    const selectedModel = resolveSelectedModel(id, manifest.id);
    if (selectedModel) {
      const envKey = MODEL_ENV_VARS[id];
      if (envKey) env[envKey] = selectedModel;
    }
    // Server scripts bind to *_PORT env var when set, else fall back to a
    // hard-coded default. Pipe the persisted port through.
    const cfgPort = resolveServicePort(manifest);
    if (cfgPort) {
      const portEnv = PORT_ENV_VARS[id];
      if (portEnv) env[portEnv] = String(cfgPort);
    }

    // Flag startingServices so /api/services reflects '启动中' across page
    // refreshes during the post-spawn health-probe window. A background
    // watcher clears the flag once the sidecar settles (running / stopped
    // / error / 60s timeout). Anything that returns before kicking off
    // the watcher must clear the flag itself (handled in finally below).
    setStarting(id, true);
    let watcherStarted = false;
    try {
      const { command: spawnCmd, args: spawnArgs } = resolveSpawnCommand(manifest.scripts.start);
      const child = spawn(spawnCmd, spawnArgs, {
        detached: process.platform !== 'win32',
        // Pipe so wireUpSidecarReadyListener can watch the ready marker
        // AND mirror stdout/stderr into the per-service log via appendLog.
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      // Coordinate push-based ready marker with the polling watcher so
      // exactly one logical 'started' fires per spawn. Without this flag,
      // a fast spawn fires from marker AND watcher (~5s later) — running
      // every always-on hook twice concurrently. Codex P2 3251557957 /
      // same shape as f5fc234f autostart fix.
      let markerFired = false;
      wireUpSidecarReadyListener(child, id, () => {
        if (markerFired) return; // wireUpSidecarReadyListener has its own internal guard too
        markerFired = true;
        request.log.info(`[services] /start ${id} → ready marker seen, firing 'started' event`);
        void fireServiceEvent(id, 'started');
        // After readiness, release the parent-side pipe FDs so the child
        // isn't tied to the parent's stdio lifecycle. Python ignores
        // SIGPIPE by default (BrokenPipeError on write to closed pipe
        // gets swallowed by uvicorn's logging module), so the core serve
        // loop is unaffected. Without this, the parent's `child.stdout`
        // listener pins the child handle in the parent process and the
        // child's stdio FDs stay tied to parent's process FDs — when the
        // API exits or restarts, the child can break (codex P1
        // 3249880339).
        child.stdout?.destroy();
        child.stderr?.destroy();
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
          // Use probeServiceHealth (raw probe) instead of getServiceState
          // here: getServiceState rewrites non-running results to
          // 'starting' when startingServices is set (which we did at
          // line ~321 before spawning), so a launcher that exits 0
          // without bringing up the sidecar would get a false 'starting'
          // and be reported as successful start. The real signal is
          // whether the sidecar is actually serving its /health
          // endpoint — either 'running' (HTTP 200 with status='running')
          // or 'starting' from its OWN /health response (status='loading',
          // model still loading but already serving).
          const rawProbe = await probeServiceHealth(manifest);
          if (rawProbe.status === 'running' || rawProbe.status === 'starting') {
            // Do NOT store child.pid here — the launcher already exited, so
            // this PID is stale. Storing it would make /stop kill a reused PID
            // and return success without stopping the real daemon. Letting it
            // stay empty forces /stop to fall through to script/port-based stop.
            // Spawn finished cleanly + service responding — background-watch
            // until fully running so the UI's 启动中 → 运行中 transition is
            // reflected without keeping the HTTP handler open.
            watcherStarted = true;
            request.log.info(
              `[services] /start ${id} → spawned (earlyExit=0, probe=${rawProbe.status}), watcher polling for running`,
            );
            void watchForRunningAndFire(id, manifest, request.log, () => markerFired);
            return { ok: true, message: `${manifest.name} start initiated`, state: await getServiceState(manifest) };
          }
        }
        const logs = readLogTail(id, 20);
        request.log.error(
          { serviceId: id, exitCode: earlyExit, logs },
          `service start failed: ${manifest.name} exited immediately`,
        );
        appendLog(id, `[start] service exited immediately (code ${earlyExit})\n`);
        reply.status(500);
        return { error: `${manifest.name} exited immediately (code ${earlyExit})`, logs };
      }
      setServicePid(id, child.pid);
      watcherStarted = true;
      request.log.info(`[services] /start ${id} → spawned (pid=${child.pid}), watcher polling for running`);
      void watchForRunningAndFire(id, manifest, request.log);
      // (background watcher fire-and-forget; setStarting handled inside)
      return {
        ok: true,
        message: `${manifest.name} start initiated (pid: ${child.pid})`,
        state: await getServiceState(manifest),
      };
    } catch {
      reply.status(500);
      return { error: `Failed to start ${manifest.name}: spawn error` };
    } finally {
      // If we never kicked off the background watcher (any early-return
      // path above), clear startingServices here so the UI doesn't stay
      // stuck on 启动中.
      if (!watcherStarted) setStarting(id, false);
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
      // Validate the PID still belongs to our service before killing it.
      // PIDs are recycled by the OS — if our spawned process exited and
      // the OS later assigned the same PID to an unrelated process, a
      // blind SIGTERM would kill that innocent process. isServiceProcess
      // inspects the cmdline (ps / Get-CimInstance) and checks for our
      // start script path / basename, so a recycled PID misses and is
      // treated as stale.
      if (!isServiceProcess(storedPid, manifest)) {
        // Stale stored PID — original child gone, PID either dead or
        // recycled to something we don't own. Clear and fall through
        // to stop-script / port-based kill which can still terminate
        // the real running daemon (if any).
        clearServicePid(id);
        // FALL THROUGH (no return) — next branches try other strategies.
      } else {
        // winTaskKill returns false on failure (doesn't throw); SIGTERM
        // to a negative pgid can throw if the group is gone. Distinguish
        // confirmed kill vs failed kill — only return early on confirmed.
        // On failure, fall through to stop-script / port-based kill
        // (codex P2 3249737122).
        let killed = false;
        try {
          if (process.platform === 'win32') {
            killed = winTaskKill(storedPid);
          } else {
            process.kill(-storedPid, 'SIGTERM');
            killed = true;
          }
        } catch (err) {
          // Distinguish "process already gone" (effective success) from
          // "we can't kill it" (real failure → fall through to fallbacks).
          // ESRCH = no such process: kill effectively succeeded, the
          // sidecar isn't running under that PID anymore. EPERM and
          // anything else = process likely alive but we can't signal it
          // (ownership / elevation), so we MUST try stop-script / port
          // fallbacks (codex P2 3250137869).
          const code = (err as NodeJS.ErrnoException)?.code;
          killed = code === 'ESRCH';
        }
        if (killed) {
          clearServicePid(id);
          return {
            ok: true,
            message: `${manifest.name} stopped (pid ${storedPid})`,
            state: await getServiceState(manifest),
          };
        }
        // Kill call returned false (Windows taskkill refused, e.g.
        // permissions or stuck process) — clear the stored PID so we
        // don't retarget the same dead handle, and fall through to the
        // next strategy.
        clearServicePid(id);
        request.log.warn(
          { serviceId: id, storedPid },
          'stored-PID kill returned false — falling through to stop-script / port-based kill',
        );
      }
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
          return { ok: true, message: `${manifest.name} stopped via script`, state: await getServiceState(manifest) };
        } catch {
          reply.status(500);
          return { ok: false, error: `Failed to run stop script for ${manifest.name}` };
        }
      }
    }

    // 3) Fallback: port-based kill.
    // Stored PID lives in this API process only — after API restart we lose
    // it, and the service kept running on the port we wrote to services.json.
    // Probe the configured/allocated port (resolveServicePort honours
    // services.json cfg.port first, then manifest.port). Probing the
    // manifest default would miss services launched on a user-chosen or
    // auto-allocated port and silently return ok while leaving them alive.
    const stopPort = resolveServicePort(manifest);
    if (!stopPort) {
      reply.status(400);
      return { error: `Service "${id}" has no stored PID, stop script, or port` };
    }

    try {
      const candidatePids = await findPidsByPort(stopPort);
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
        request.log.warn({ serviceId: id, port: stopPort, candidatePids }, 'stop: no matching processes killed');
      }
      return {
        ok: true,
        message: `${manifest.name} stopped (${killed.length} process(es))`,
        state: await getServiceState(manifest),
      };
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

      const scriptPath = resolveScriptPath(manifest.scripts.install);
      if (!existsSync(scriptPath)) {
        reply.status(400);
        return { error: `Install script not found: ${scriptPath}` };
      }
      // Sync port validation — must happen BEFORE we acquire the lock
      // so caller-supplied bad input fails fast without leaving the
      // service stuck on 'installing'. Reject non-integer values
      // (9876.5 etc.) too; downstream PORT env vars + listen() expect
      // integers (codex P2 3250197028).
      let resolvedPort: number | undefined = body.port;
      if (typeof resolvedPort === 'number') {
        if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
          reply.status(400);
          return { error: 'Invalid port (expected integer 1..65535)' };
        }
      }

      // Atomic acquire of the in-flight install lock. Sync — no await —
      // so two concurrent POST handlers race-safely: exactly one acquires
      // the lock, the rest see false and bail. This MUST happen before
      // the next await (port allocation below), otherwise the old
      // getServiceState-based 'installing' check would let two
      // simultaneous installs both pass while the status field was still
      // being awaited (codex P2 finding 3247373269).
      if (!tryAcquireInstallLock(id)) {
        return { ok: true, message: `${manifest.name} is already installing` };
      }

      // From here on we own the lock. Every error path must either
      // setInstalling(id, false) explicitly OR let the background async
      // IIFE's markFailed clear it. Sync failures below clean up
      // explicitly; the IIFE handles its own cleanup.
      //
      // All three sync setServiceConfig writes are wrapped in a single
      // try so any sync throw (disk full, permission, corrupt path)
      // releases the in-memory lock before propagating the error.
      // Without this, a thrown write would leave installingServices.has(id)
      // true forever and every later /install short-circuits as "already
      // installing" until API restart (codex P2 3249880345).
      let installModel: string | undefined;
      let env: Record<string, string>;
      try {
        if (!resolvedPort) {
          // Priority for default install port (when caller omits `port`):
          //   1. services.json cfg.port — console's previous user intent
          //      (e.g. user changed port in UI on a prior install).
          //   2. env port (EMBED_PORT etc.) — .env-set default.
          //   3. allocateAvailablePort starting from manifest.port —
          //      hunts a free port if manifest.port is taken.
          //
          // resolveServicePort returns 1/2 OR manifest.port (cfg/env/manifest
          // priority chain). For 1 and 2 we trust the user's explicit
          // intent and don't auto-allocate around it. For 3 (manifest
          // fallback) we MUST do allocateAvailablePort — codex P2
          // 3250197033: if the manifest default is occupied, persisting
          // it leads to address-in-use on start. So we re-derive:
          // ask for cfg/env first via getServiceConfig(id) + env vars,
          // and only call allocateAvailablePort when both are unset.
          const cfg = getServiceConfig(id);
          if (cfg.port) {
            resolvedPort = cfg.port;
          } else {
            // Check env port via the strict parser (same source of truth
            // as resolveServicePort, but without the manifest fallback).
            // Scan manifest.configVars first, then PORT_ENV_VARS[id] —
            // mirrors resolveServicePort's order so install defaulting
            // honors the dedicated *_PORT env (e.g. LLM_POSTPROCESS_PORT)
            // even when the manifest's configVars doesn't list it.
            // Codex P2 3252047839.
            let envPort: number | undefined;
            const envCandidates: string[] = [...manifest.configVars];
            const dedicatedPortEnv = PORT_ENV_VARS[id];
            if (dedicatedPortEnv && !envCandidates.includes(dedicatedPortEnv)) {
              envCandidates.push(dedicatedPortEnv);
            }
            for (const envVar of envCandidates) {
              const val = process.env[envVar];
              if (!val || val.startsWith('http')) continue;
              const trimmed = val.trim();
              if (!/^\d+$/.test(trimmed)) continue;
              const n = Number.parseInt(trimmed, 10);
              if (Number.isFinite(n) && n > 0 && n <= 65535) {
                envPort = n;
                break;
              }
            }
            resolvedPort = envPort ?? (await allocateAvailablePort(manifest.port ?? 9000));
          }
        }
        setServiceConfig(id, { port: resolvedPort });

        // Resolve install model (sync — no async/IO).
        installModel = body.model && isValidModelId(body.model) ? body.model : undefined;
        if (!installModel) installModel = resolveSelectedModel(id, manifest.id);
        if (installModel) {
          setServiceConfig(id, { selectedModel: installModel });
        }

        // Prep the env that the install child will inherit.
        env = { ...process.env } as Record<string, string>;
        normalizeProxyEnv(env);
        if (installModel) {
          const envKey = MODEL_ENV_VARS[id];
          if (envKey) env[envKey] = installModel;
        }
        const portEnv = PORT_ENV_VARS[id];
        if (portEnv) env[portEnv] = String(resolvedPort);

        // In-flight lock already acquired earlier via tryAcquireInstallLock.
        // Persist installStatus = 'installing' so /api/services reflects it
        // even if the user refreshes the page mid-install (the lock is
        // process-local; installStatus is persistent in services.json).
        // The actual install work (ensurePython → pre-install uninstall →
        // install spawn → autostart) is FULLY backgrounded so the HTTP
        // response returns immediately with state.status='installing'.
        setServiceConfig(id, {
          installStatus: 'installing',
          lastInstallError: undefined,
          lastInstallTroubleshootHint: undefined,
        });
      } catch (preflightErr) {
        setInstalling(id, false);
        throw preflightErr;
      }

      const markFailed = (errMsg: string, hint?: string | null): void => {
        request.log.error({ serviceId: id, errMsg }, `service install failed: ${manifest.name}`);
        // Release the in-memory install lock unconditionally, even if
        // persisting failure state throws (disk full / perm denied /
        // bad path). Without finally, `setServiceConfig` throwing here
        // would leave installingServices.has(id) true forever, so every
        // subsequent /install would short-circuit as "already installing"
        // until the API restarts (codex P2 3249837227).
        try {
          setServiceConfig(id, {
            installStatus: 'failed',
            lastInstallError: errMsg,
            lastInstallTroubleshootHint: hint ?? undefined,
          });
        } catch (cfgErr) {
          const msg = cfgErr instanceof Error ? cfgErr.message : String(cfgErr);
          request.log.error({ serviceId: id, err: msg }, 'failed to persist install failure state');
        } finally {
          setInstalling(id, false);
        }
      };

      void (async () => {
        try {
          // python-bootstrap: idempotent, can be multi-minute on first run.
          // Failures here used to leak setInstalling=true permanently.
          try {
            const { ensurePython } = await import('../domains/services/python-bootstrap.js');
            appendLog(id, '\n[install] preparing Python 3.12+ runtime...\n');
            await ensurePython(request.log, (chunk) => appendLog(id, chunk));
            appendLog(id, '[install] Python ready, installing service dependencies...\n');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendLog(id, `[install] python-bootstrap failed: ${msg}\n`);
            markFailed(`Python 3.12+ bootstrap failed: ${msg}`);
            return;
          }

          // Pre-install uninstall: guarantee clean venv. Failures here are
          // warnings (the install script will rebuild), don't fail install.
          if (manifest.scripts.uninstall) {
            const uninstallPath = resolveScriptPath(manifest.scripts.uninstall);
            if (existsSync(uninstallPath)) {
              appendLog(id, '\n[install] running pre-install uninstall to clean any stale venv...\n');
              const { command: uCmd, args: uArgs } = resolveSpawnCommand(manifest.scripts.uninstall);
              await new Promise<void>((resolve) => {
                const cleanupChild = spawn(uCmd, uArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                cleanupChild.stdout?.on('data', (d: Buffer) => appendLog(id, d.toString()));
                cleanupChild.stderr?.on('data', (d: Buffer) => appendLog(id, d.toString()));
                cleanupChild.on('error', (err) => {
                  appendLog(id, `[install] pre-install uninstall spawn errored: ${err.message}\n`);
                  request.log.warn({ serviceId: id, err: err.message }, 'pre-install uninstall errored (continuing)');
                  resolve();
                });
                cleanupChild.on('close', (code) => {
                  appendLog(id, `[install] pre-install uninstall finished (exit ${code ?? 'null'})\n`);
                  if (code !== 0) {
                    request.log.warn(
                      { serviceId: id, exitCode: code },
                      'pre-install uninstall exited non-zero (continuing — install will rebuild)',
                    );
                  }
                  resolve();
                });
              });
            } else {
              appendLog(id, `[install] pre-install uninstall skipped: script not found at ${uninstallPath}\n`);
            }
          } else {
            appendLog(id, '[install] pre-install uninstall skipped: manifest has no uninstall script\n');
          }

          // Spawn install child. The outer sync handler already guaranteed
          // manifest.scripts.install is set; the assertion narrows for TS
          // inside the background async closure (TS loses the narrow
          // across the closure boundary).
          // biome-ignore lint/style/noNonNullAssertion: pre-checked above
          const { command: installCmd, args: installArgs } = resolveSpawnCommand(manifest.scripts.install!);
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(installCmd, installArgs, { stdio: ['pipe', 'pipe', 'pipe'], env });
          } catch (err) {
            markFailed(`Failed to spawn install script: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

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

          child.on('error', (err) => {
            markFailed(`install spawn errored: ${err.message}`);
          });
          child.on('close', (code) => {
            try {
              if (code !== 0) {
                const troubleshootHint = detectInstallFailureHint(output);
                request.log.error(
                  { serviceId: id, exitCode: code, output: output.slice(-2000) },
                  `service install failed: ${manifest.name}`,
                );
                setServiceConfig(id, {
                  installStatus: 'failed',
                  lastInstallError: `Install failed (exit ${code}): ${output.slice(-2000)}`,
                  lastInstallTroubleshootHint: troubleshootHint ?? undefined,
                });
                return;
              }
              setServiceConfig(id, {
                installStatus: 'installed',
                lastInstallError: undefined,
                lastInstallTroubleshootHint: undefined,
              });
              // Install = install only. Start = user clicks start.
              // The previous install→autostart-when-enabled chain shipped
              // confused UX: when enabled=true persisted from a prior
              // session, install would attempt to spawn the sidecar in
              // the background — but failures were silent (no console
              // surface), leaving users with enabled=true + status=stopped
              // and no diagnostic. Per user decision: keep install scoped
              // to "prepare environment", let the user explicitly start.
            } catch (writeErr) {
              // setServiceConfig (writeFileSync) can throw on disk-full /
              // perm-denied. This callback is an async event handler with
              // no outer catch — letting it throw would surface as an
              // uncaught exception and could terminate the API process
              // (codex P2 3251505997). Route the write failure through
              // markFailed so the UI still gets a useful state and the
              // lock releases cleanly.
              const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
              request.log.error(
                { serviceId: id, err: msg },
                'failed to persist post-install state — write threw inside close handler',
              );
              try {
                markFailed(`Install completed but failed to persist state: ${msg}`);
              } catch {
                // markFailed itself could throw if its own setServiceConfig
                // dies the same way; swallow — setInstalling in finally
                // below still releases the lock.
              }
            } finally {
              setInstalling(id, false);
            }
          });
        } catch (outerErr) {
          // Outer safety — any error path that escaped the inner try/catch
          // still clears installing so the UI doesn't get stuck.
          const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
          markFailed(`unexpected install error: ${msg}`);
        }
      })();

      // Return the in-flight state synchronously. installingServices already
      // set, installStatus='installing' persisted — UI gets a clean snapshot.
      return { ok: true, state: await getServiceState(manifest) };
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

    setUninstalling(id, true);
    appendLog(id, `\n[uninstall] starting ${scriptPath} ...\n`);

    // Stop the running sidecar BEFORE removing its venv. Without this, the
    // uninstall script just deletes ~/.cat-cafe/<service>-venv on disk but
    // the running Python process keeps serving on the port — and the
    // already-in-memory model means it survives a venv delete. The user
    // then reinstalls, sees status='running' immediately, and reasonably
    // assumes install auto-started the service. It didn't — the stale PID
    // from a previous start is still alive. Best-effort here: try stored
    // PID → stop script → port-based kill. Errors swallowed because
    // uninstall should proceed regardless of whether stop succeeds.
    try {
      const storedPid = getServicePid(id);
      let stopped = false;
      // winTaskKill returns false on failure (e.g. permission denied,
      // process gone in racy way) instead of throwing; SIGTERM may throw
      // when the group is already dead (same effect as success). Only
      // mark `stopped` on a confirmed kill — otherwise fall through to
      // the port-based fallback below, which uses fresh isServiceProcess
      // probes to find lingering sidecars (codex P2 3249737130).
      if (storedPid && isServiceProcess(storedPid, manifest)) {
        try {
          if (process.platform === 'win32') {
            stopped = winTaskKill(storedPid);
          } else {
            process.kill(-storedPid, 'SIGTERM');
            stopped = true;
          }
        } catch (err) {
          // Only ESRCH (no such process) counts as "effectively stopped".
          // EPERM means the sidecar is still alive but we can't signal it,
          // so we must fall through to the port-based fallback below
          // (codex P2 3250137869 — same shape as the /stop fix).
          const code = (err as NodeJS.ErrnoException)?.code;
          stopped = code === 'ESRCH';
        }
        clearServicePid(id);
      } else if (storedPid) {
        clearServicePid(id); // stale, drop record
      }
      if (!stopped) {
        const stopPort = resolveServicePort(manifest);
        if (stopPort) {
          const candidatePids = await findPidsByPort(stopPort);
          for (const pid of candidatePids) {
            if (!isServiceProcess(pid, manifest)) continue;
            try {
              if (process.platform === 'win32') {
                if (winTaskKill(pid)) stopped = true;
              } else {
                process.kill(pid, 'SIGTERM');
                stopped = true;
              }
            } catch {
              /* skip */
            }
          }
        }
      }
      if (stopped) {
        appendLog(id, '[uninstall] stopped running sidecar before venv removal\n');
        // Brief grace so the process actually releases the port + file
        // handles before rm -rf the venv that holds its python binary.
        await new Promise((res) => setTimeout(res, 300));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(id, `[uninstall] pre-stop best-effort errored (continuing): ${msg}\n`);
    }

    try {
      const uninstallEnv: Record<string, string> = { ...process.env } as Record<string, string>;
      normalizeProxyEnv(uninstallEnv);
      const { command: uninstallCmd, args: uninstallArgs } = resolveSpawnCommand(manifest.scripts.uninstall);
      appendLog(id, `[uninstall] spawn: ${uninstallCmd} ${uninstallArgs.join(' ')}\n`);
      const child = spawn(uninstallCmd, uninstallArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: uninstallEnv,
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
      try {
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
        setServiceConfig(id, {
          installStatus: 'none',
          enabled: false,
          lastInstallError: undefined,
          lastInstallTroubleshootHint: undefined,
        });
        return {
          ok: true,
          message: `${manifest.name} uninstalled successfully`,
          state: await getServiceState(manifest),
        };
      } catch {
        reply.status(500);
        return { ok: false, error: `Failed to run uninstall script for ${manifest.name}` };
      }
    } finally {
      setUninstalling(id, false);
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

      return { ok: true, config: getServiceConfig(id), state: await getServiceState(manifest) };
    },
  );
};
