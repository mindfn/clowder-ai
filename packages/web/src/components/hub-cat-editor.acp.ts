/**
 * F161: ACP transport configuration helpers for the Hub Cat Editor.
 *
 * Extracted from hub-cat-editor.model.ts to stay within the 500-line limit.
 * NOTE: Does NOT import from hub-cat-editor.model.ts to avoid circular dependency.
 */

export const ACP_TRANSPORT_OPTIONS: Array<{ value: 'cli' | 'acp'; label: string }> = [
  { value: 'cli', label: 'CLI' },
  { value: 'acp', label: 'ACP' },
];

/** Clients that support both CLI and ACP transport — show transport selector for these. */
const DUAL_TRANSPORT_CLIENTS: ReadonlySet<string> = new Set(['opencode']);

/** Whether to show the transport selector for this client. */
export function showTransportSelector(client: string): boolean {
  return DUAL_TRANSPORT_CLIENTS.has(client);
}

/** Whether ACP is forced on (no choice) for this client. */
export function isAcpOnlyClient(client: string): boolean {
  return client === 'acp';
}

export function defaultAcpCommandForClient(client: string): string {
  if (client === 'opencode') return 'opencode';
  return '';
}

export function defaultAcpStartupArgsForClient(client: string): string {
  if (client === 'opencode') return 'acp --pure';
  return '';
}
