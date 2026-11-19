import type { CatData } from '@/hooks/useCatData';
import type { ProfileItem } from './hub-accounts.types';
import { filterAccounts, type HubCatEditorFormState } from './hub-cat-editor.model';

export function isEligibleAgyAccount(account: ProfileItem, carrier: 'native' | 'acp' = 'native'): boolean {
  if (account.authType !== 'oauth') return false;
  if (account.envVars && Object.keys(account.envVars).length > 0) return false;
  if (carrier === 'acp') return !account.agy;
  if (account.agy) return account.agyLoginStatus === 'ready' || account.agyLoginStatus === 'refreshable';
  return true;
}

export function eligibleAgyAccounts(profiles: ProfileItem[], carrier: 'native' | 'acp' = 'native'): ProfileItem[] {
  return filterAccounts('google', profiles).filter((account) => isEligibleAgyAccount(account, carrier));
}

export function pickDefaultAgyAccount(
  profiles: ProfileItem[],
  carrier: 'native' | 'acp' = 'native',
): ProfileItem | undefined {
  const eligible = eligibleAgyAccounts(profiles, carrier);
  if (carrier === 'native') {
    return eligible.find((account) => Boolean(account.agy)) ?? eligible[0];
  }
  return eligible[0];
}

export function usesAgyNative(form: Pick<HubCatEditorFormState, 'clientId' | 'carrier' | 'agyNativeEnabled'>) {
  return form.clientId === 'google' && form.carrier !== 'acp' && form.agyNativeEnabled === true;
}

export function usesAgyAcp(form: Pick<HubCatEditorFormState, 'clientId' | 'carrier' | 'agyAcpEnabled'>) {
  return form.clientId === 'google' && form.carrier === 'acp' && form.agyAcpEnabled === true;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function buildAgyProfilePatch(
  form: HubCatEditorFormState,
  cat?: CatData | null,
  accountAuthType?: 'oauth' | 'api_key' | null,
): Record<string, unknown> {
  const acp = usesAgyAcp(form);
  if (!usesAgyNative(form) && !acp)
    return cat?.agyProfile?.carrier === 'native' || cat?.agyProfile?.carrier === 'acp' ? { agyProfile: null } : {};
  if (accountAuthType === 'api_key') throw new Error('AGY Native 需要隔离 Profile 中已登录的个人 OAuth');
  const profileId = form.agyProfileId?.trim() || form.catId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(profileId)) throw new Error('隔离 Profile ID 格式无效');
  const model = form.defaultModel.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))
    throw new Error('AGY Native 模型需填写实际模型 ID，例如 gemini-4-neon-xhigh');
  const trustedWorkspaces = Array.from(
    new Set(
      (form.agyTrustedWorkspaces ?? '')
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  );
  if (!form.agyAutoApprove && !trustedWorkspaces.length) throw new Error('AGY Native 需要至少一个批准工作区');
  const homeRoot = form.agyHomeRoot?.trim();
  if (trustedWorkspaces.some((path) => !isAbsolutePath(path)) || (homeRoot && !isAbsolutePath(homeRoot))) {
    throw new Error('Profile 根目录和批准工作区必须使用绝对路径');
  }
  return {
    agyProfile: {
      enabled: form.agyProfileEnabled ?? true,
      carrier: acp ? 'acp' : 'native',
      profileId,
      ...(homeRoot ? { homeRoot } : {}),
      model,
      autoApprove: form.agyAutoApprove === true,
      trustedWorkspaces,
    },
  };
}
