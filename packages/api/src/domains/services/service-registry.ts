import { execSync } from 'node:child_process';
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

function isScriptRunning(script: string | { unix: string; windows: string } | undefined): boolean {
  if (!script) return false;
  const absolutePath = resolveScriptPath(script);
  if (process.platform === 'win32') {
    try {
      const escaped = absolutePath.replace(/'/g, "''").replace(/\\/g, '\\\\');
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"CommandLine like '%${escaped}%'\\" | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }
  try {
    const out = execSync(`pgrep -f "${absolutePath}"`, { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function detectProcessStatus(manifest: ServiceManifest): ServiceStatus | null {
  if (isScriptRunning(manifest.scripts.install)) return 'installing';
  if (isScriptRunning(manifest.scripts.uninstall)) return 'uninstalling';
  if (isScriptRunning(manifest.scripts.start)) return 'starting';
  return null;
}

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

export function getKnownServices(): ServiceManifest[] {
  return KNOWN_SERVICES;
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
  let { status } = probe;
  if (status === 'stopped' || status === 'unknown') {
    const processStatus = detectProcessStatus(manifest);
    if (processStatus) status = processStatus;
  }
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
