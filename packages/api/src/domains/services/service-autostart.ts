import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getAllServiceConfigs, setServiceConfig } from './service-config.js';
import { fireServiceEvent } from './service-hooks.js';
import { resolveScriptPath, resolveSpawnCommand, wireUpSidecarReadyListener } from './service-logs.js';
import type { ServiceManifest } from './service-manifest.js';
import { MODEL_ENV_VARS, PORT_ENV_VARS } from './service-manifest.js';
import { resolveSelectedModel } from './service-model-resolver.js';
import { checkInstalled, getKnownServices, getServiceState, setServicePid } from './service-registry.js';

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

const READY_POLL_INTERVAL_MS = 5000;
const READY_POLL_MAX_ATTEMPTS = 60; // 5 minutes — long enough for slow model loads

/**
 * After spawning a service, poll its health probe until it reports `running`,
 * then fire its onReady hooks. Fire-and-forget — never blocks the caller.
 */
function watchAndAnnounceReady(manifest: ServiceManifest, log: Logger, isAlreadyFired?: () => boolean): void {
  void (async () => {
    for (let attempt = 0; attempt < READY_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
      // If the push-based ready marker (wireUpSidecarReadyListener) has
      // already fired 'started' for this service, the watcher's role is
      // done — exit silently. Without this guard the watcher would
      // re-fire 'started' a few seconds later and run every always-on
      // hook (e.g. embedding catch-up) twice on a single startup, which
      // is wasted work and risks race conditions in hook side effects
      // (codex P2 3251529185).
      if (isAlreadyFired?.()) return;
      try {
        const state = await getServiceState(manifest);
        if (state.status === 'running') {
          if (isAlreadyFired?.()) return; // re-check after async probe
          log.info('[services] ✓ %s — healthy, firing onReady hooks', manifest.name);
          await fireServiceEvent(manifest.id, 'started');
          return;
        }
      } catch {
        /* probe failure → try again next tick */
      }
    }
    const totalSec = (READY_POLL_INTERVAL_MS * READY_POLL_MAX_ATTEMPTS) / 1000;
    log.warn(`[services] ⏱ ${manifest.name} — did not become healthy within ${totalSec}s, hooks not fired`);
  })();
}

/**
 * Sweep services.json on API startup: any service stuck in
 * installStatus='installing' is from a previous API process that died
 * during the install (Ctrl+C / crash / OS reboot) — the in-memory
 * installingServices Set was cleared with the process, but the persisted
 * config retained 'installing'. Surface it as 'failed' so the UI doesn't
 * show a card permanently stuck on '安装中' until the user happens to
 * notice and click again.
 */
function clearStaleInstallingState(log: Logger): void {
  const configs = getAllServiceConfigs();
  const services = getKnownServices();
  for (const [id, cfg] of Object.entries(configs)) {
    if (cfg.installStatus === 'installing') {
      const manifest = services.find((m) => m.id === id);
      // Clear the 'installing' status so checkInstalled falls through to
      // venv probe — recovers installs that completed before API crashed.
      setServiceConfig(id, { installStatus: 'none' });
      if (manifest && checkInstalled(manifest)) {
        log.info(`[services] ${id} was 'installing' on startup — venv present, recovering to installed`);
        setServiceConfig(id, { installStatus: 'installed' });
        continue;
      }
      log.warn(`[services] ${id} was 'installing' on startup — marking failed (previous API process died mid-install)`);
      setServiceConfig(id, {
        installStatus: 'failed',
        lastInstallError: 'API restarted while install was in progress — please click 安装 again.',
        lastInstallTroubleshootHint: undefined,
      });
    }
  }
}

export async function autoStartEnabledServices(log: Logger): Promise<void> {
  clearStaleInstallingState(log);

  const configs = getAllServiceConfigs();
  const services = getKnownServices();

  const enabled = services.filter((m) => configs[m.id]?.enabled);
  if (enabled.length === 0) {
    log.info('[services] No services enabled');
    return;
  }

  log.info('[services] %d service(s) enabled: %s', enabled.length, enabled.map((m) => m.name).join(', '));

  for (const manifest of enabled) {
    const cfg = configs[manifest.id]!;
    if (!manifest.scripts.start) continue;
    if (
      manifest.supportedPlatforms &&
      !manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux' | 'win32')
    ) {
      log.info('[services] ⊘ %s — not supported on %s', manifest.name, process.platform);
      continue;
    }
    if (!checkInstalled(manifest)) {
      log.warn('[services] ✗ %s — enabled but not installed (run install from Settings)', manifest.name);
      continue;
    }

    const state = await getServiceState(manifest);
    if (state.status === 'running' || state.status === 'starting') {
      log.info('[services] ✓ %s — already running (port %s)', manifest.name, manifest.port ?? '?');
      // Fire hooks immediately for already-running services (e.g. when API
      // restarts but the sidecar was left running by a previous instance).
      if (state.status === 'running') {
        void fireServiceEvent(manifest.id, 'started');
      } else {
        watchAndAnnounceReady(manifest, log);
      }
      continue;
    }

    const scriptPath = resolveScriptPath(manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      log.warn('[services] ✗ %s — start script not found: %s', manifest.name, scriptPath);
      continue;
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    // Normalize invalid proxy schemes (clash / v2ray often emit socks://
    // which httpx rejects). Mirrors prereq-check.sh's normalize_proxy_scheme
    // so the autostart spawn behaves identically to a user-triggered start.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      const v = env[key];
      if (v && v.startsWith('socks://')) env[key] = `socks5${v.slice('socks'.length)}`;
    }
    // Resolve via shared helper so autostart honors the SAME priority chain
    // as /api/services/:id/start and the install endpoint: cfg.selectedModel
    // first, then matrix recommendation default. Without this, a legacy
    // services.json (enabled+installed but no selectedModel — e.g. user
    // installed via an older code path) would launch the sidecar with the
    // model env unset; server scripts are now fail-fast on missing env so
    // autostart would silently fail on first restart after the fail-fast
    // commit landed.
    const resolvedModel = resolveSelectedModel(manifest.id, manifest.id);
    if (resolvedModel) {
      const envKey = MODEL_ENV_VARS[manifest.id];
      if (envKey) env[envKey] = resolvedModel;
    }
    if (cfg.port) {
      const portKey = PORT_ENV_VARS[manifest.id];
      if (portKey) env[portKey] = String(cfg.port);
    }

    log.info('[services] ⟳ %s — starting (port %s)...', manifest.name, manifest.port ?? '?');
    try {
      const { command, args } = resolveSpawnCommand(manifest.scripts.start);
      const child = spawn(command, args, {
        detached: process.platform !== 'win32',
        // Pipe stdout/stderr so we can watch for the sidecar's ready
        // marker AND keep mirroring its output to the per-service log
        // (via wireUpSidecarReadyListener.appendLog inside).
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      child.on('error', () => {});
      if (child.pid) setServicePid(manifest.id, child.pid);
      // Push-based fast path: as soon as the sidecar prints its ready
      // marker (or uvicorn's "Uvicorn running on http"), fire 'started'.
      // Local flag tells the polling watcher to skip its own fire so we
      // dispatch exactly one logical 'started' per spawn (codex P2
      // 3251529185).
      let markerFired = false;
      wireUpSidecarReadyListener(child, manifest.id, () => {
        if (markerFired) return; // wireUp also has its own internal guard
        markerFired = true;
        log.info('[services] ✓ %s — ready marker seen, firing onReady hooks', manifest.name);
        void fireServiceEvent(manifest.id, 'started');
        // After readiness, release parent-side pipe FDs so the child
        // isn't tied to the parent's stdio lifecycle. Same rationale as
        // commit a25002c0 in services.ts /start: without this, parent
        // exit/restart breaks the child's stdout pipe and Python's
        // SIGPIPE handling is the only thing keeping the daemon alive
        // (fragile across platforms, no SIGPIPE on Windows). Codex P1
        // 3250058952.
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
      child.unref();
      // Polling watcher as safety net (covers slow boot beyond stdout
      // buffer flush, missing markers in old Python scripts, etc.).
      // Pass markerFired getter so the watcher bails when the push path
      // already won the race — one logical 'started' event per spawn.
      watchAndAnnounceReady(manifest, log, () => markerFired);
    } catch {
      log.warn('[services] ✗ %s — failed to spawn start script', manifest.name);
    }
  }
}
