import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getEnvironmentProfile } from './environment-detector.js';
import { buildRecommendation } from './recommendation-matrix.js';
import type { ServiceRecommendation } from './recommendation-types.js';
import { getServiceConfig } from './service-config.js';
import { resolveRepoRoot, resolveScriptPath } from './service-logs.js';
import type { InstallStatus, ServiceManifest, ServiceState, ServiceStatus } from './service-manifest.js';
import { PORT_ENV_VARS } from './service-manifest.js';

/**
 * Expand a leading `~` to $HOME. Node's path module never does this; values
 * coming from `.env` files via non-shell loaders (Node `--env-file`, dotenv,
 * etc.) keep the literal `~`, so a config like CAT_CAFE_HOME=~/.cat-cafe-shared
 * would yield `<cwd>/~/.cat-cafe-shared`. Codex P2 3251761227.
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

const KNOWN_SERVICES: ServiceManifest[] = [
  {
    id: 'whisper-stt',
    name: 'Whisper 语音转写',
    type: 'python',
    port: 9876,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/whisper-venv',
      packages: ['mlx-whisper', 'fastapi', 'uvicorn'],
      estimatedMinutes: 5,
    },
    scripts: {
      install: { unix: 'scripts/services/whisper-install.sh', windows: 'scripts/services/whisper-install.ps1' },
      start: { unix: 'scripts/services/whisper-server.sh', windows: 'scripts/services/whisper-server.ps1' },
      uninstall: { unix: 'scripts/services/whisper-uninstall.sh', windows: 'scripts/services/whisper-uninstall.ps1' },
    },
    enablesFeatures: ['voice-input', 'connector-stt'],
    configVars: ['WHISPER_URL', 'NEXT_PUBLIC_WHISPER_URL'],
  },
  {
    id: 'mlx-tts',
    name: 'MLX-Audio 语音合成',
    type: 'python',
    port: 9879,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/tts-venv',
      packages: ['mlx-audio', 'fastapi', 'uvicorn'],
      estimatedMinutes: 2,
    },
    scripts: {
      install: { unix: 'scripts/services/tts-install.sh', windows: 'scripts/services/tts-install.ps1' },
      start: { unix: 'scripts/services/tts-server.sh', windows: 'scripts/services/tts-server.ps1' },
      uninstall: { unix: 'scripts/services/tts-uninstall.sh', windows: 'scripts/services/tts-uninstall.ps1' },
    },
    enablesFeatures: ['voice-output', 'voice-companion'],
    configVars: ['TTS_URL'],
  },
  {
    id: 'embedding-model',
    name: 'Embedding 语义搜索',
    type: 'python',
    port: 9880,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/embed-venv',
      packages: ['sentence-transformers', 'fastapi', 'uvicorn'],
      estimatedMinutes: 3,
    },
    scripts: {
      install: { unix: 'scripts/services/embed-install.sh', windows: 'scripts/services/embed-install.ps1' },
      start: { unix: 'scripts/services/embed-server.sh', windows: 'scripts/services/embed-server.ps1' },
      uninstall: { unix: 'scripts/services/embed-uninstall.sh', windows: 'scripts/services/embed-uninstall.ps1' },
    },
    enablesFeatures: ['memory-semantic-search'],
    configVars: ['EMBED_URL', 'EMBED_PORT'],
  },
  {
    id: 'llm-postprocess',
    name: 'LLM 转写纠正',
    type: 'python',
    port: 9878,
    healthEndpoint: '/health',
    prerequisites: {
      runtime: 'python3.10+',
      venvPath: '~/.cat-cafe/llm-venv',
      packages: ['mlx-vlm', 'fastapi', 'uvicorn', 'pydantic'],
      estimatedMinutes: 30,
    },
    scripts: {
      install: {
        unix: 'scripts/services/llm-postprocess-install.sh',
        windows: 'scripts/services/llm-postprocess-install.ps1',
      },
      start: {
        unix: 'scripts/services/llm-postprocess-server.sh',
        windows: 'scripts/services/llm-postprocess-server.ps1',
      },
      uninstall: {
        unix: 'scripts/services/llm-postprocess-uninstall.sh',
        windows: 'scripts/services/llm-postprocess-uninstall.ps1',
      },
    },
    enablesFeatures: ['voice-postprocess'],
    configVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
  },
];

/**
 * Strict port parser: rejects partial parses like `Number.parseInt('127.0.0.1:9880')`
 * (returns 127) or `Number.parseInt('9880/foo')` (returns 9880). Only accepts
 * a string that IS a positive integer in the valid port range. Codex P2 3249279172.
 */
function parseStrictPort(val: string | undefined): number | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null;
  return n;
}

export function resolveServicePort(manifest: ServiceManifest): number | null {
  // Same priority chain as resolveServiceEndpoint so spawn and health
  // probe agree on the port. Previously this only looked at
  // services.json + manifest, ignoring env-port overrides — which
  // resolveServiceEndpoint DID honor — so a deployment with
  // EMBED_PORT=9999 in .env had the sidecar spawned on the manifest
  // default (e.g. 9880) while health resolution probed 9999, making
  // /start report success while subsequent health/watch logic appeared
  // stuck (codex P1 finding 3249156652).
  //
  // Order: services.json (console's most recent intent) > env port
  // (static .env override) > manifest.port (hardcoded default).
  const cfg = getServiceConfig(manifest.id);
  if (cfg.port) return cfg.port;
  for (const envVar of manifest.configVars) {
    const port = parseStrictPort(process.env[envVar]);
    if (port) return port;
  }
  // Also honor the dedicated *_PORT env that each server script reads — not
  // every manifest lists it in configVars (e.g. llm-postprocess only exposes
  // NEXT_PUBLIC_LLM_POSTPROCESS_URL), so without this lookup an operator
  // setting LLM_POSTPROCESS_PORT in .env would have the sidecar bind to the
  // override (autostart injects via PORT_ENV_VARS) but health/stop logic
  // would probe manifest.port — same kind of port-drift the configVars path
  // already handles (codex P2 3251761229).
  const portEnv = PORT_ENV_VARS[manifest.id];
  if (portEnv) {
    const port = parseStrictPort(process.env[portEnv]);
    if (port) return port;
  }
  if (manifest.port) return manifest.port;
  return null;
}

export function resolveServiceEndpoint(idOrManifest: string | ServiceManifest): string | null {
  const manifest = typeof idOrManifest === 'string' ? KNOWN_SERVICES.find((s) => s.id === idOrManifest) : idOrManifest;
  if (!manifest) return null;

  // Priority (highest → lowest):
  //   1. env is a full URL (http://...) — strongest user intent, typically
  //      "point at a remote server, don't run local sidecar at all" (e.g.
  //      EMBED_URL=http://embedding.corp:8080). services.json port should
  //      NOT silently override that intent.
  //   2. services.json cfg.port — console's most-recent user intent. When
  //      user changes port in the UI, health check must follow immediately.
  //      Previously env-as-port masked this — that was the codex P2 finding.
  //   3. env as port number — .env-set default port (no full URL, just a
  //      number like EMBED_PORT=9881). Static config, lower priority than
  //      console state.
  //   4. manifest.port — hardcoded default fallback.

  // 1. env full URL
  for (const envVar of manifest.configVars) {
    const val = process.env[envVar];
    if (val?.startsWith('http')) return val;
  }

  // 2. services.json port
  const cfg = getServiceConfig(manifest.id);
  if (cfg.port) return `http://127.0.0.1:${cfg.port}`;

  // 3. env port number (strict — reject host:port partial parses like
  //    `EMBED_URL=127.0.0.1:9880` resolving to port 127)
  for (const envVar of manifest.configVars) {
    const port = parseStrictPort(process.env[envVar]);
    if (port) return `http://127.0.0.1:${port}`;
  }
  // Also honor the dedicated *_PORT env (PORT_ENV_VARS map) — see
  // resolveServicePort for the same rationale (codex P2 3251761229).
  const portEnv = PORT_ENV_VARS[manifest.id];
  if (portEnv) {
    const port = parseStrictPort(process.env[portEnv]);
    if (port) return `http://127.0.0.1:${port}`;
  }

  // 4. manifest default
  if (manifest.port) return `http://127.0.0.1:${manifest.port}`;

  return null;
}

export function resolveHealthUrl(manifest: ServiceManifest): string | null {
  if (!manifest.healthEndpoint) return null;
  const endpoint = resolveServiceEndpoint(manifest);
  if (!endpoint) return null;
  return `${endpoint}${manifest.healthEndpoint}`;
}

async function probePort(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return new Promise((res) => {
    const sock = createConnection({ port, host: '127.0.0.1', timeout: 2000 });
    sock.on('connect', () => {
      sock.destroy();
      res(true);
    });
    sock.on('error', () => res(false));
    sock.on('timeout', () => {
      sock.destroy();
      res(false);
    });
  });
}

type HealthResult = { status: ServiceStatus; detail?: Record<string, unknown>; error?: string };

function classifyFetchError(err: unknown): HealthResult {
  if (err instanceof Error && err.name === 'AbortError') {
    return { status: 'error', error: 'health probe timeout' };
  }
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string } }).cause : undefined;
  if (cause?.code === 'ECONNREFUSED') return { status: 'stopped' };
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ECONNREFUSED')) return { status: 'stopped' };
  return { status: 'error', error: msg };
}

export async function probeServiceHealth(manifest: ServiceManifest): Promise<HealthResult> {
  // Public-export wrapper around probeHealth so /start can do raw probe
  // checks WITHOUT getServiceState's startingServices override. Without
  // this, an earlyExit=0 path where the sidecar never actually came up
  // would see `getServiceState()` rewrite the raw 'stopped' probe to
  // 'starting' (because we already set startingServices) and pass the
  // success branch. Real probe result is the only signal that the
  // sidecar is reachable.
  return probeHealth(manifest);
}

async function probeHealth(manifest: ServiceManifest): Promise<HealthResult> {
  const url = resolveHealthUrl(manifest);
  if (!url) {
    const port = resolveServicePort(manifest);
    if (port) {
      const listening = await probePort(port);
      return { status: listening ? 'running' : 'stopped' };
    }
    return { status: 'unknown' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (detail.status === 'loading') return { status: 'starting', detail };
    return { status: 'running', detail };
  } catch (err) {
    return classifyFetchError(err);
  } finally {
    clearTimeout(timeout);
  }
}

function resolveVenvPath(venvPath: string): string {
  const catCafeMatch = venvPath.match(/^~\/\.cat-cafe\/(.+)/);
  if (catCafeMatch) {
    const subPath = catCafeMatch[1];
    // When the operator has explicitly set $CAT_CAFE_HOME, it is the
    // SOLE authoritative location: scripts/services/* run only against
    // that path, so a stale venv at <repoRoot>/.cat-cafe or ~/.cat-cafe
    // is a false-positive (we'd report 'installed' but actual install
    // attempts and autostart spawn against $CAT_CAFE_HOME and fail).
    // Don't fall through (codex P2 3250354116).
    if (process.env.CAT_CAFE_HOME) {
      return resolve(expandTilde(process.env.CAT_CAFE_HOME), subPath);
    }
    // No explicit override — probe the default locations the scripts
    // would use in that case:
    //   1. <repoRoot>/.cat-cafe — python-resolve.sh derives this when
    //      CAT_CAFE_HOME is unset (Redis-convention layout).
    //   2. ~/.cat-cafe — legacy pre-a34ab1f2 install location, kept so
    //      old installs from pre-migration code don't show "not installed"
    //      after the user pulls.
    const projectLocal = resolve(resolveRepoRoot(), '.cat-cafe', subPath);
    if (existsSync(projectLocal)) return projectLocal;
  }
  if (venvPath.startsWith('~/')) return resolve(homedir(), venvPath.slice(2));
  return resolve(venvPath);
}

export function checkInstalled(manifest: ServiceManifest): boolean {
  const config = getServiceConfig(manifest.id);
  const venv = manifest.prerequisites?.venvPath;

  if (config.installStatus === 'installed') {
    // Revalidate against on-disk venv. Persisted 'installed' can drift
    // from reality if CAT_CAFE_HOME was changed, the venv was removed
    // out-of-band (rm -rf, manual cleanup), or the services.json was
    // restored from another machine. Without the probe, the UI hides
    // the install path while start / autostart fail against a missing
    // runtime. Codex P2 3256075417.
    if (!venv) return true; // service has no venv (e.g. binary type) — trust the flag
    return existsSync(resolveVenvPath(venv));
  }
  if (config.installStatus === 'failed' || config.installStatus === 'installing') {
    return false;
  }
  // installStatus='none' or undefined — no explicit state recorded
  // (services.json never written or set to 'none' by uninstall). Fall
  // through to venv probe so manual / offline / script installs are
  // recovered instead of being permanently shown as not-installed.
  if (!venv) return true;
  return existsSync(resolveVenvPath(venv));
}

export function getInstallStatus(manifest: ServiceManifest): InstallStatus {
  const config = getServiceConfig(manifest.id);
  const venv = manifest.prerequisites?.venvPath;

  // Revalidate persisted 'installed' against on-disk venv — same drift
  // concern as checkInstalled (codex P2 3256075417). 'failed' and
  // 'installing' are transition states we still trust as authoritative.
  if (config.installStatus === 'installed') {
    if (!venv) return 'installed';
    return existsSync(resolveVenvPath(venv)) ? 'installed' : 'none';
  }
  if (config.installStatus && config.installStatus !== 'none') return config.installStatus;
  if (!venv) return 'installed';
  return existsSync(resolveVenvPath(venv)) ? 'installed' : 'none';
}

// Removed: isScriptRunning + detectProcessStatus. They probed `pgrep -f
// <install.sh>` / Win32_Process CommandLine to recover process state across
// API restarts, but the probe false-positived (matching API's own argv,
// shell history, sibling worktrees, etc.) and silently kept the install
// button hidden on fresh installs. Going forward, service state derives
// only from explicit signals:
//   - probeHealth() (HTTP /health on the configured port) → running / stopped
//   - installStatus persisted in services.json (set by install/uninstall routes)
//   - in-memory servicePids (set on spawn, cleared on stop/exit)
// If the API restarts mid-install, the stored PID is lost and the next
// /api/services call reports 'stopped' / installStatus='none'. The user
// clicks install again — much less confusing than a phantom 'installing'.

const servicePids = new Map<string, number>();
export function setServicePid(id: string, pid: number): void {
  servicePids.set(id, pid);
}
export function getServicePid(id: string): number | undefined {
  return servicePids.get(id);
}
export function clearServicePid(id: string): void {
  servicePids.delete(id);
}

// In-memory transient state: which services are currently being installed
// or uninstalled by *this* API process. Not persisted — when the API
// restarts, in-flight spawns die with it, and the next /api/services call
// naturally reflects the new state. This lets the UI survive page refresh
// during a long install: the server still knows the install is running
// because the spawn handle is in-process, so the next fetch returns the
// same 'installing' status without needing a stale services.json entry.
const installingServices = new Set<string>();
const uninstallingServices = new Set<string>();
const startingServices = new Set<string>();
/**
 * Atomic check-and-set for the install lock. Returns true iff the lock
 * was acquired (i.e. no other concurrent install for this id was
 * already in flight). Sync — no `await` — so two concurrent POST
 * /api/services/:id/install handlers race-safely: exactly one gets
 * `acquired=true`, the rest get false and must bail. Used by the
 * install endpoint to avoid double-spawning on double-click / retry /
 * two-clients-same-time scenarios that would otherwise pass through
 * the original getServiceState-based 'installing' check while the
 * status was still being awaited.
 */
export function tryAcquireInstallLock(id: string): boolean {
  if (installingServices.has(id)) return false;
  installingServices.add(id);
  return true;
}

export function setInstalling(id: string, value: boolean): void {
  if (value) installingServices.add(id);
  else installingServices.delete(id);
}
export function setUninstalling(id: string, value: boolean): void {
  if (value) uninstallingServices.add(id);
  else uninstallingServices.delete(id);
}
export function setStarting(id: string, value: boolean): void {
  if (value) startingServices.add(id);
  else startingServices.delete(id);
}
export function isInstalling(id: string): boolean {
  return installingServices.has(id);
}
export function isUninstalling(id: string): boolean {
  return uninstallingServices.has(id);
}
export function isStarting(id: string): boolean {
  return startingServices.has(id);
}

export function getKnownServices(): ServiceManifest[] {
  return KNOWN_SERVICES;
}

/**
 * Probe a single port for availability by attempting to bind.
 * Returns true if the port is free, false if anything else is listening.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
}

/**
 * Find an unused port starting from `start` (inclusive) and walking up by 1.
 * Returns the first available port within `range` tries. Falls back to `start`
 * if none of the candidates are free — caller can still try to bind and let
 * the OS error if the entire range is saturated.
 */
export async function allocateAvailablePort(start: number, range = 100): Promise<number> {
  for (let p = start; p < start + range; p++) {
    if (await isPortAvailable(p)) return p;
  }
  return start;
}

export function getServiceById(id: string): ServiceManifest | undefined {
  return KNOWN_SERVICES.find((s) => s.id === id);
}

function enrichManifestModels(manifest: ServiceManifest, rec: ServiceRecommendation): ServiceManifest {
  type Model = NonNullable<ServiceManifest['prerequisites']['models']>[number];
  if (rec.models.length === 0) return manifest;
  const models: Model[] = rec.models.map((m, i) => ({
    name: m.name,
    size: m.size,
    autoDownload: true,
    description: m.description,
    ...(i === 0 ? { isDefault: true } : {}),
  }));
  return { ...manifest, prerequisites: { ...manifest.prerequisites, models } };
}

/**
 * Probe health on a polling loop until the service settles into a terminal
 * state (running / stopped / error) or the timeout expires. Used by start
 * handlers to keep startingServices flagged while we wait for the spawned
 * sidecar to either become healthy or visibly fail — so the UI shows
 * '启动中' across page refreshes instead of immediately flipping to '未启动'.
 * Caller is responsible for setStarting(false) once this resolves.
 */
export async function waitUntilHealthSettles(
  manifest: ServiceManifest,
  timeoutMs: number,
): Promise<'running' | 'stopped' | 'error' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const probe = await probeHealth(manifest);
    if (probe.status === 'running' || probe.status === 'stopped' || probe.status === 'error') {
      return probe.status;
    }
  }
  return 'timeout';
}

export async function getServiceState(manifest: ServiceManifest, refreshEnv = false): Promise<ServiceState> {
  const probe = await probeHealth(manifest);
  // In-flight install/uninstall/start is a live UI signal — override probe
  // status so a page refresh during a long install/start still shows the
  // correct transitional state. The sets are process-local; if the API
  // restarted, the spawn died and the sets are empty, so the user correctly
  // sees stopped/none. Probe-derived 'starting' (HTTP /health returning
  // status='loading') still wins through naturally — startingServices is
  // only set during the brief spawn-watch window before health probe
  // reports back.
  let status = probe.status;
  if (installingServices.has(manifest.id)) status = 'installing';
  else if (uninstallingServices.has(manifest.id)) status = 'uninstalling';
  else if (startingServices.has(manifest.id) && status !== 'running') status = 'starting';
  const config = getServiceConfig(manifest.id);
  const installStatus = getInstallStatus(manifest);
  const profile = getEnvironmentProfile(refreshEnv);
  const recommendation = buildRecommendation(manifest.id, profile);
  return {
    manifest: enrichManifestModels(manifest, recommendation),
    status,
    installed: installStatus === 'installed',
    installStatus,
    enabled: config.enabled,
    selectedModel: config.selectedModel,
    lastChecked: Date.now(),
    healthDetail: probe.detail,
    error: probe.error,
    lastInstallError: config.lastInstallError,
    lastInstallTroubleshootHint: config.lastInstallTroubleshootHint,
    recommendation,
  };
}

export async function getAllServiceStates(): Promise<ServiceState[]> {
  return Promise.all(KNOWN_SERVICES.map((m) => getServiceState(m)));
}
