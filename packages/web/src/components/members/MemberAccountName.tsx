'use client';
import { builtinAccountIdForClient, type ClientId } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { accountDisplayName } from '../accounts/account-directory-view';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useMemberText } from './editor-presentation';

/** Read the original binding and name; selection and login remain in the account domain. */
export function MemberAccountName({ cat, accounts }: { cat: CatData; accounts: ProfileItem[] }) {
  const t = useMemberText();
  const copy = useShellCopy(accountsCopy);
  if (cat.id === 'gpt-pro') return <span>{t('云端')}</span>;
  const accountRef = cat.accountRef ?? (cat.cli ? builtinAccountIdForClient(cat.clientId as ClientId) : undefined);
  const account = accounts.find((profile) => profile.id === accountRef);
  if (!account) return <span>{accountRef ?? t('认证未确认')}</span>;
  const name = accountDisplayName(account, copy);
  const duplicate = accounts.some((other) => other.id !== account.id && accountDisplayName(other, copy) === name);
  const identity = account.codex?.identity;
  return (
    <span data-testid={`member-account-${cat.id}`}>
      {name}
      {duplicate && (
        <small>
          {identity ? `${identity.email ?? account.id} · ${copy.workspaceId} ${identity.workspaceId}` : account.id}
        </small>
      )}
      {cat.accountBindingMode === 'override' && <small>{copy.override}</small>}
    </span>
  );
}
