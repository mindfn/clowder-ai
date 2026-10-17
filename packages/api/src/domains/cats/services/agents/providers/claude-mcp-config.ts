import { resolveProviderMcpConfigResolution } from './provider-mcp-config.js';

export type ClaudeMcpServerConfig = Record<string, unknown>;
export interface ClaudeMcpConfigResolution {
  readonly servers: Record<string, ClaudeMcpServerConfig>;
  readonly source: 'capabilities.json' | 'fallback';
}

/** CLI and SDK share discovery; Native consumes the same resolver's server map. */
export async function resolveClaudeMcpConfig(input: {
  readonly callbackEnv?: Record<string, string>;
  readonly workingDirectory?: string;
  readonly mcpServerPath?: string;
}): Promise<ClaudeMcpConfigResolution | undefined> {
  if (!input.callbackEnv || !input.mcpServerPath) return undefined;
  return resolveProviderMcpConfigResolution({
    ...input,
    callbackEnv: input.callbackEnv,
    mcpServerPath: input.mcpServerPath,
    provider: 'claude',
  });
}
