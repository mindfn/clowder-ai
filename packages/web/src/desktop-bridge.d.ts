type DesktopUpdatePromptAction = 'download' | 'later' | 'skip' | 'open-release';

interface DesktopUpdatePromptPayload {
  version: string;
  currentVersion: string;
  platform: 'windows' | 'macos';
  assetName: string;
  releaseUrl: string;
}

interface DesktopUpdateProgressPayload {
  phase: 'downloading';
  version: string;
  assetName: string;
  progress: number;
}

interface DesktopBridge {
  onStatus(callback: (message: string) => void): () => void;
  onUpdatePrompt(callback: (prompt: DesktopUpdatePromptPayload) => void): () => void;
  onUpdateProgress(callback: (progress: DesktopUpdateProgressPayload | null) => void): () => void;
  updatePromptReady(): void;
  sendUpdatePromptAction(action: DesktopUpdatePromptAction, version: string): void;
}

interface Window {
  desktopBridge?: DesktopBridge;
}
