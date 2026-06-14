import { extractUserEnvTemplates, resolveEnvMap } from '../env-map.js';

export interface AcpProcessEnvAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  envVars?: Record<string, string>;
}

export interface PrepareAcpProcessEnvOptions {
  clientId: string;
  provider?: string | null;
  baseModel?: string;
  account?: AcpProcessEnvAccount | null;
}

export function prepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): Record<string, string> | undefined {
  const account = options.account ?? null;
  const resolved: Record<string, string> = {};

  if (account?.authType === 'api_key') {
    if (!account.apiKey) {
      throw new Error(
        `account "${account.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }
    const userEnvTemplates = account.envVars ? extractUserEnvTemplates(account.envVars) : undefined;
    Object.assign(
      resolved,
      resolveEnvMap(
        options.clientId,
        options.provider ?? undefined,
        { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: options.baseModel },
        userEnvTemplates,
      ),
    );
  }

  const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
  const templateRe = /\$\{(\w+)\}/;
  if (account?.envVars) {
    for (const [key, value] of Object.entries(account.envVars)) {
      if (!validEnvKey.test(key) || key.startsWith('CAT_CAFE_')) continue;
      if (templateRe.test(value)) continue;
      resolved[key] = value;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
