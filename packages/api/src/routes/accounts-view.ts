import { type AccountConfig, accountQuotaOwnerMatches, builtinAccountFamilyForRef } from '@cat-cafe/shared';
import { codexManagedStatus } from '../config/codex-account-identity.js';
import { nativeCodexAccountView } from './accounts-native-view.js';
// clowder-ai#340: Derive client identity from well-known account IDs, not stored protocol.
/** Synthesize a ProviderProfileView-compatible object from AccountConfig. */
export function accountToView(id: string, account: AccountConfig, apiKeyPresent: boolean, projectRoot?: string) {
  const isBuiltin = account.authType === 'oauth' && !!builtinAccountFamilyForRef(id);
  const builtinClient = builtinAccountFamilyForRef(id);
  const clientId = account.clientId ?? (isBuiltin ? builtinClient : undefined);
  const codexView = account.codex ? { ...account.codex, status: codexManagedStatus(account.codex) } : undefined;
  const codexStatus = codexView?.status;
  const quota =
    account.codex &&
    account.quota?.status === 'ok' &&
    (codexStatus !== 'ready' || !accountQuotaOwnerMatches(account.quota, id, account.codex.identity))
      ? {
          ...account.quota,
          status: 'unavailable' as const,
          items: [],
          error: codexStatus === 'ready' ? '额度身份未确认，请重新查询此账号' : '请先处理此账号的官方登录',
        }
      : account.quota;
  const nativeView =
    projectRoot && clientId === 'openai' && account.authType === 'oauth' && !account.codex
      ? nativeCodexAccountView(projectRoot, id)
      : {};
  return {
    id,
    name: account.displayName ?? id,
    displayName: account.displayName ?? id,
    ...nativeView,
    ...(!isBuiltin ? { displayName: account.displayName ?? id } : {}),
    authType: account.authType,
    builtin: isBuiltin,
    ...(quota ? { quota } : {}),
    kind: isBuiltin ? 'builtin' : account.authType,
    ...(codexView ? { codex: codexView } : {}),
    ...(clientId ? { clientId } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    models: account.models ? [...account.models] : [],
    ...(account.modelAliases && Object.keys(account.modelAliases).length > 0
      ? { modelAliases: { ...account.modelAliases } }
      : {}),
    hasApiKey: apiKeyPresent,
    mode: account.authType === 'api_key' ? ('api_key' as const) : ('subscription' as const),
    ...(account.envVars && Object.keys(account.envVars).length > 0 ? { envVars: { ...account.envVars } } : {}),
    createdAt: '',
    updatedAt: '',
  };
}

/** Derive a slug-like ID from display name, avoiding collisions with existing accounts. */
export function deriveAccountId(displayName: string, existingIds: Set<string>, customApiKey: boolean): string {
  let seed =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `account-${Date.now()}`;
  if (customApiKey && builtinAccountFamilyForRef(seed)) seed = `custom-${seed}`;
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}
