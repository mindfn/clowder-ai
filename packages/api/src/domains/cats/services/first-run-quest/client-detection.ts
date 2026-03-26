/**
 * F140: Detect which agent CLI clients are installed on the user's machine.
 * Only returns clients that are actually available for binding.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface DetectedClient {
  /** Client key matching ClientValue in frontend */
  client: 'anthropic' | 'openai' | 'google' | 'opencode' | 'dare';
  /** Human-readable label */
  label: string;
  /** CLI binary name */
  cli: string;
  /** Whether the CLI binary is found in PATH */
  installed: boolean;
  /** CLI version string if installed */
  version?: string;
  /** Whether an API key env var is set for this provider */
  hasApiKey: boolean;
}

interface CliSpec {
  client: DetectedClient['client'];
  label: string;
  cli: string;
  versionCmd: string;
  envKey: string;
}

const CLI_SPECS: CliSpec[] = [
  { client: 'anthropic', label: 'Claude', cli: 'claude', versionCmd: 'claude --version', envKey: 'ANTHROPIC_API_KEY' },
  { client: 'openai', label: 'Codex', cli: 'codex', versionCmd: 'codex --version', envKey: 'OPENAI_API_KEY' },
  { client: 'opencode', label: 'OpenCode', cli: 'opencode', versionCmd: 'opencode version', envKey: 'ANTHROPIC_API_KEY' },
  { client: 'google', label: 'Gemini', cli: 'gemini', versionCmd: 'gemini --version', envKey: 'GOOGLE_API_KEY' },
  { client: 'dare', label: 'Dare', cli: 'dare', versionCmd: 'dare --version', envKey: '' },
];

async function checkCli(spec: CliSpec): Promise<DetectedClient> {
  try {
    const { stdout } = await execAsync(spec.versionCmd, { timeout: 5000 });
    const version = stdout.trim().split('\n').at(0) ?? '';
    return {
      client: spec.client,
      label: spec.label,
      cli: spec.cli,
      installed: true,
      version: version || undefined,
      hasApiKey: spec.envKey ? Boolean(process.env[spec.envKey]) : false,
    };
  } catch {
    return {
      client: spec.client,
      label: spec.label,
      cli: spec.cli,
      installed: false,
      hasApiKey: spec.envKey ? Boolean(process.env[spec.envKey]) : false,
    };
  }
}

/** Detect all available CLI clients in parallel. */
export async function detectAvailableClients(): Promise<DetectedClient[]> {
  const results = await Promise.all(CLI_SPECS.map(checkCli));
  return results;
}

/** Return only clients that are installed. */
export async function getInstalledClients(): Promise<DetectedClient[]> {
  const all = await detectAvailableClients();
  return all.filter((c) => c.installed);
}
