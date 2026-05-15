export interface ServiceManifest {
  id: string;
  name: string;
  type: 'python' | 'node' | 'binary';
  supportedPlatforms?: ('darwin' | 'linux' | 'win32')[];
  port?: number;
  healthEndpoint?: string;

  prerequisites: {
    runtime?: string;
    venvPath?: string;
    packages?: string[];
    models?: {
      name: string;
      size: string;
      autoDownload: boolean;
      isDefault?: boolean;
      description?: string;
      platforms?: ('darwin' | 'linux' | 'win32')[];
    }[];
    estimatedMinutes?: number;
  };

  scripts: {
    install?: string | { unix: string; windows: string };
    start?: string | { unix: string; windows: string };
    stop?: string | { unix: string; windows: string };
    uninstall?: string | { unix: string; windows: string };
  };

  enablesFeatures: string[];
  configVars: string[];
}

export type ServiceStatus = 'running' | 'starting' | 'installing' | 'uninstalling' | 'stopped' | 'unknown' | 'error';

// Added 'installing' so python-bootstrap can persist its progress between
// API restarts via services.json. Regular service install routes set
// 'installed' or 'failed' synchronously after their child exits, so this
// new state is rare for them — but doesn't break: existing consumers
// (UI button condition, install endpoint) only branch on 'failed' /
// 'installed', everything else falls through to "not yet installed".
export type InstallStatus = 'none' | 'installing' | 'installed' | 'failed';

export interface ServiceConfig {
  enabled: boolean;
  selectedModel?: string;
  port?: number;
  installStatus?: InstallStatus;
  // Last install failure surface — written by /api/services/:id/install
  // child-close handler when the script exits non-zero, cleared on the
  // next successful install. Frontend reads these from ServiceState to
  // display a single toast after polling spots installStatus flipping
  // from 'installing' → 'failed' (the install endpoint itself now
  // returns immediately so the failure never came back in the POST
  // response).
  lastInstallError?: string;
  lastInstallTroubleshootHint?: string;
  // python-bootstrap meta-service fields. Populated only for the
  // 'python-bootstrap' pseudo-service entry in services.json; left
  // undefined for normal services (whisper / tts / embed / llm).
  pythonPath?: string;
  pythonArch?: string;
  pythonSource?: string;
}

export const MODEL_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_MODEL',
  'mlx-tts': 'TTS_MODEL',
  'embedding-model': 'EMBED_MODEL',
  'llm-postprocess': 'LLM_POSTPROCESS_MODEL',
};

/** Env var that each server script reads to bind its listening port. */
export const PORT_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_PORT',
  'mlx-tts': 'TTS_PORT',
  'embedding-model': 'EMBED_PORT',
  'llm-postprocess': 'LLM_POSTPROCESS_PORT',
};

export interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  installed: boolean;
  installStatus: InstallStatus;
  enabled: boolean;
  selectedModel?: string;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
  /** Last install failure message (script output tail). */
  lastInstallError?: string;
  /** detectInstallFailureHint result from the previous failed install run. */
  lastInstallTroubleshootHint?: string;
  recommendation?: import('./recommendation-types.js').ServiceRecommendation;
}
