import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getAllServiceConfigs } from './service-config.js';
import { fireServiceEvent } from './service-hooks.js';
import { resolveScriptPath, resolveSpawnCommand } from './service-logs.js';
import type { ServiceManifest } from './service-manifest.js';
import { MODEL_ENV_VARS } from './service-manifest.js';
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
function watchAndAnnounceReady(manifest: ServiceManifest, log: Logger): void {
  void (async () => {
    for (let attempt = 0; attempt < READY_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
      try {
        const state = await getServiceState(manifest);
        if (state.status === 'running') {
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

export async function autoStartEnabledServices(log: Logger): Promise<void> {
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
    if (cfg.selectedModel) {
      const envKey = MODEL_ENV_VARS[manifest.id];
      if (envKey) env[envKey] = cfg.selectedModel;
    }

    log.info('[services] ⟳ %s — starting (port %s)...', manifest.name, manifest.port ?? '?');
    try {
      const { command, args } = resolveSpawnCommand(manifest.scripts.start);
      const child = spawn(command, args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        env,
      });
      child.on('error', () => {});
      if (child.pid) setServicePid(manifest.id, child.pid);
      child.unref();
      // Watch the new sidecar's health probe and fire onReady hooks when
      // it transitions to running. Consumers (e.g. evidence embed catch-up)
      // register on manifest.id via service-hooks.onServiceReady().
      watchAndAnnounceReady(manifest, log);
    } catch {
      log.warn('[services] ✗ %s — failed to spawn start script', manifest.name);
    }
  }
}
