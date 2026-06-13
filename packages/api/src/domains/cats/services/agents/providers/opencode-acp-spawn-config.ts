import {
  deriveOpenCodeApiType,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  type OpenCodeRuntimeConfigDebugSummary,
  parseOpenCodeModel,
  summarizeOpenCodeRuntimeConfigForDebug,
  writeOpenCodeRuntimeConfig,
} from './opencode-config-template.js';

export interface OpenCodeAcpSpawnAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  models?: readonly string[];
}

export interface OpenCodeAcpSpawnConfigOptions {
  projectRoot: string;
  profileId: string;
  clientId: string;
  command: string;
  providerName?: string | null;
  defaultModel?: string | null;
  account?: OpenCodeAcpSpawnAccount | null;
}

export interface PreparedOpenCodeAcpSpawnConfig {
  env: Record<string, string>;
  configPath: string;
  runtimeConfigSummary: OpenCodeRuntimeConfigDebugSummary;
}

const OPENCODE_COMMAND_BASENAMES = new Set(['opencode', 'opencode.cmd', 'opencode.exe']);

export function isOpenCodeCommand(command: string): boolean {
  const basename = command.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return OPENCODE_COMMAND_BASENAMES.has(basename);
}

function isOpenCodeAcpTarget(clientId: string, command: string): boolean {
  return clientId === 'opencode' || isOpenCodeCommand(command);
}

function resolveEffectiveOpenCodeModel(
  providerName: string | null | undefined,
  defaultModel: string | null | undefined,
): { providerName: string; model: string } | null {
  const modelProviderName = providerName?.trim() || undefined;
  const trimmedDefaultModel = defaultModel?.trim() || undefined;
  if (!trimmedDefaultModel) return null;

  const parsed = parseOpenCodeModel(trimmedDefaultModel);
  if (parsed) {
    if (modelProviderName && parsed.providerName !== modelProviderName) {
      return {
        providerName: modelProviderName,
        model: `${modelProviderName}/${trimmedDefaultModel}`,
      };
    }
    return {
      providerName: modelProviderName ?? parsed.providerName,
      model: trimmedDefaultModel,
    };
  }

  if (!modelProviderName) return null;
  return {
    providerName: modelProviderName,
    model: `${modelProviderName}/${trimmedDefaultModel}`,
  };
}

/**
 * Build the spawn-scoped OpenCode runtime config used by `opencode acp`.
 *
 * Unlike normal OpenCode invocations, ACP pools are long-lived processes, so this
 * intentionally excludes per-invocation instructions/MCP and only pins provider,
 * model, and credentials at process spawn time.
 */
export function prepareOpenCodeAcpSpawnConfig(
  options: OpenCodeAcpSpawnConfigOptions,
): PreparedOpenCodeAcpSpawnConfig | null {
  if (!isOpenCodeAcpTarget(options.clientId, options.command)) return null;

  const effective = resolveEffectiveOpenCodeModel(options.providerName, options.defaultModel);
  if (!effective) return null;

  const account = options.account ?? null;
  if (account?.authType === 'api_key' && !account.apiKey) {
    throw new Error(`account "${account.id}" is configured as api_key but has no API key set`);
  }

  const runtimeConfigOptions = {
    providerName: effective.providerName,
    models: account?.models?.length ? account.models : [effective.model],
    defaultModel: effective.model,
    apiType: deriveOpenCodeApiType(effective.providerName),
    hasBaseUrl: Boolean(account?.baseUrl),
    omitProviderAuth: account?.authType !== 'api_key',
  } as const;

  const configPath = writeOpenCodeRuntimeConfig(
    options.projectRoot,
    options.profileId,
    'acp-pool',
    runtimeConfigOptions,
  );

  const env: Record<string, string> = { OPENCODE_CONFIG: configPath };
  if (account?.authType === 'api_key' && account.apiKey) {
    env[OC_API_KEY_ENV] = account.apiKey;
    if (account.baseUrl) env[OC_BASE_URL_ENV] = account.baseUrl;
  }

  return {
    env,
    configPath,
    runtimeConfigSummary: summarizeOpenCodeRuntimeConfigForDebug(runtimeConfigOptions),
  };
}
