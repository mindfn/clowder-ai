import type { ClientId } from './cat.js';

export type ClientProtocol = 'cli' | 'acp' | 'a2a' | 'custom';

export interface ClientProviderDef {
  clientId: ClientId;
  label: string;
  protocol: ClientProtocol;
  /** CLI binary name (only for protocol='cli') */
  cliName?: string;
  /** Account family for filtering auth profiles */
  accountFamily?: string;
  /** Whether the user must provide a command/startup config */
  needsCommandConfig?: boolean;
}

export const CLIENT_PROVIDER_DEFS: readonly ClientProviderDef[] = [
  { clientId: 'anthropic', label: 'Claude', protocol: 'cli', cliName: 'claude', accountFamily: 'anthropic' },
  { clientId: 'openai', label: 'Codex', protocol: 'cli', cliName: 'codex', accountFamily: 'openai' },
  { clientId: 'google', label: 'Gemini', protocol: 'cli', cliName: 'gemini', accountFamily: 'google' },
  { clientId: 'kimi', label: 'Kimi', protocol: 'cli', cliName: 'kimi', accountFamily: 'kimi' },
  { clientId: 'dare', label: 'Dare', protocol: 'cli', cliName: 'dare', accountFamily: 'dare' },
  { clientId: 'opencode', label: 'OpenCode', protocol: 'cli', cliName: 'opencode', accountFamily: 'opencode' },
  { clientId: 'antigravity', label: 'Antigravity', protocol: 'cli', needsCommandConfig: true },
  { clientId: 'acp', label: 'ACP', protocol: 'acp', needsCommandConfig: true },
  { clientId: 'a2a', label: 'A2A', protocol: 'a2a' },
  { clientId: 'catagent', label: 'CatAgent', protocol: 'custom', accountFamily: 'anthropic' },
];

export function getClientProviderDef(clientId: string): ClientProviderDef | undefined {
  return CLIENT_PROVIDER_DEFS.find((d) => d.clientId === clientId);
}

export function getAllClientIds(): ClientId[] {
  return CLIENT_PROVIDER_DEFS.map((d) => d.clientId);
}

export function getClientOptions(): Array<{ value: ClientId; label: string }> {
  return CLIENT_PROVIDER_DEFS.map((d) => ({ value: d.clientId, label: d.label }));
}
