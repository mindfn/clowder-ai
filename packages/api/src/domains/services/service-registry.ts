import type { ServiceManifest, ServiceState, ServiceStatus } from './service-manifest.js';

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
    },
    scripts: {
      start: 'scripts/whisper-server.sh',
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
    },
    scripts: {
      start: 'scripts/tts-server.sh',
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
    },
    scripts: {
      start: 'scripts/embed-server.sh',
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
    },
    scripts: {
      start: 'scripts/llm-postprocess-server.sh',
    },
    enablesFeatures: ['voice-postprocess'],
    configVars: ['NEXT_PUBLIC_LLM_POSTPROCESS_URL'],
  },
  {
    id: 'playwright',
    name: 'Playwright 浏览器自动化',
    type: 'node',
    prerequisites: {
      packages: ['playwright'],
    },
    scripts: {},
    enablesFeatures: ['browser-automation-mcp'],
    configVars: [],
  },
];

function resolveHealthUrl(manifest: ServiceManifest): string | null {
  if (!manifest.port || !manifest.healthEndpoint) return null;
  const envUrlVar = manifest.configVars[0];
  if (envUrlVar) {
    const envUrl = process.env[envUrlVar];
    if (envUrl) return `${envUrl}${manifest.healthEndpoint}`;
  }
  return `http://127.0.0.1:${manifest.port}${manifest.healthEndpoint}`;
}

async function probeHealth(
  manifest: ServiceManifest,
): Promise<{ status: ServiceStatus; detail?: Record<string, unknown>; error?: string }> {
  const url = resolveHealthUrl(manifest);
  if (!url) return { status: 'unknown' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: 'running', detail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('abort')) {
      return { status: 'stopped' };
    }
    return { status: 'error', error: msg };
  }
}

export function getKnownServices(): ServiceManifest[] {
  return KNOWN_SERVICES;
}

export function getServiceById(id: string): ServiceManifest | undefined {
  return KNOWN_SERVICES.find((s) => s.id === id);
}

export async function getServiceState(manifest: ServiceManifest): Promise<ServiceState> {
  const probe = await probeHealth(manifest);
  return {
    manifest,
    status: probe.status,
    lastChecked: Date.now(),
    healthDetail: probe.detail,
    error: probe.error,
  };
}

export async function getAllServiceStates(): Promise<ServiceState[]> {
  return Promise.all(KNOWN_SERVICES.map(getServiceState));
}
