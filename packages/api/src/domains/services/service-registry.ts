import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getEnvironmentProfile } from './environment-detector.js';
import { buildRecommendation } from './recommendation-matrix.js';
import type { ServiceRecommendation } from './recommendation-types.js';
import { getServiceConfig } from './service-config.js';
import { resolveScriptPath } from './service-logs.js';
import type { InstallStatus, ServiceManifest, ServiceState, ServiceStatus } from './service-manifest.js';

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

export function resolveServicePort(manifest: ServiceManifest): number | null {
  const cfg = getServiceConfig(manifest.id);
  if (cfg.port) return cfg.port;
  if (manifest.port) return manifest.port;
  return null;
}

export function resolveServiceEndpoint(idOrManifest: string | ServiceManifest): string | null {
  const manifest = typeof idOrManifest === 'string' ? KNOWN_SERVICES.find((s) => s.id === idOrManifest) : idOrManifest;
  if (!manifest) return null;

  for (const envVar of manifest.configVars) {
    const val = process.env[envVar];
    if (val?.startsWith('http')) return val;
    const parsed = val ? Number.parseInt(val, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return `http://127.0.0.1:${parsed}`;
  }

  const port = resolveServicePort(manifest);
  if (port) return `http://127.0.0.1:${port}`;

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
  if (venvPath.startsWith('~/')) return resolve(homedir(), venvPath.slice(2));
  return resolve(venvPath);
}

export function checkInstalled(manifest: ServiceManifest): boolean {
  const config = getServiceConfig(manifest.id);
  if (config.installStatus) return config.installStatus === 'installed';
  const venv = manifest.prerequisites?.venvPath;
  if (!venv) return true;
  return existsSync(resolveVenvPath(venv));
}

export function getInstallStatus(manifest: ServiceManifest): InstallStatus {
  const config = getServiceConfig(manifest.id);
  if (config.installStatus) return config.installStatus;
  const venv = manifest.prerequisites?.venvPath;
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
export function setInstalling(id: string, value: boolean): void {
  if (value) installingServices.add(id);
  else installingServices.delete(id);
}
export function setUninstalling(id: string, value: boolean): void {
  if (value) uninstallingServices.add(id);
  else uninstallingServices.delete(id);
}
export function isInstalling(id: string): boolean {
  return installingServices.has(id);
}
export function isUninstalling(id: string): boolean {
  return uninstallingServices.has(id);
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

export async function getServiceState(manifest: ServiceManifest, refreshEnv = false): Promise<ServiceState> {
  const probe = await probeHealth(manifest);
  // In-flight install/uninstall is a live UI signal — override probe status
  // so a page refresh during a long install still shows '安装中'. The set
  // is process-local; if the API restarted, the spawn died and the set is
  // empty, so the user correctly sees stopped/none.
  let status = probe.status;
  if (installingServices.has(manifest.id)) status = 'installing';
  else if (uninstallingServices.has(manifest.id)) status = 'uninstalling';
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
    recommendation,
  };
}

export async function getAllServiceStates(): Promise<ServiceState[]> {
  return Promise.all(KNOWN_SERVICES.map((m) => getServiceState(m)));
}
