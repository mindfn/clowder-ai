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

export type InstallStatus = 'none' | 'installed' | 'failed';

export interface ServiceConfig {
  enabled: boolean;
  selectedModel?: string;
  port?: number;
  installStatus?: InstallStatus;
}

export const MODEL_ENV_VARS: Record<string, string> = {
  'whisper-stt': 'WHISPER_MODEL',
  'mlx-tts': 'TTS_MODEL',
  'embedding-model': 'EMBED_MODEL',
  'llm-postprocess': 'LLM_POSTPROCESS_MODEL',
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
}
