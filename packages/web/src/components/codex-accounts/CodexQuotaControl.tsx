'use client';
import { type AccountQuotaObservation, accountQuotaOwnerMatches, type CodexAccountIdentity } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { accountMessage } from '../accounts/account-message';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import { SettingsSecondaryButton } from '../settings/primitives';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { accountRequest } from './account-request';

export function CodexQuotaControl({
  accountRef,
  observation: suppliedObservation,
  reload,
  managed = false,
  identity,
}: {
  accountRef: string;
  observation?: AccountQuotaObservation;
  reload: () => Promise<void>;
  managed?: boolean;
  identity?: CodexAccountIdentity;
}) {
  const t = useShellCopy(accountsCopy);
  const language = useShellLanguage();
  const dateLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const [busy, setBusy] = useState(false);
  const [storedObservation, setObservation] = useState(suppliedObservation);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const observation =
    managed && !accountQuotaOwnerMatches(storedObservation, accountRef, identity) ? undefined : storedObservation;
  useEffect(() => {
    setObservation(suppliedObservation);
  }, [suppliedObservation]);
  const [error, setError] = useState('');
  async function query() {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ quota: AccountQuotaObservation }>(
        `/api/accounts/${encodeURIComponent(accountRef)}/codex/quota`,
        {},
      );
      if (managed && !accountQuotaOwnerMatches(result.quota, accountRef, identityRef.current))
        throw new Error('账号登录已变化，请重新查询');
      setObservation(result.quota);
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法查询额度');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{t.quota}</strong>
        <SettingsSecondaryButton disabled={busy} onClick={() => void query()}>
          {busy ? t.queryingQuota : t.queryQuota}
        </SettingsSecondaryButton>
      </div>
      {observation?.status === 'ok' ? (
        <ul>
          {observation.items.map((item) => (
            <li key={`${item.poolId ?? ''}:${item.label}`}>
              {accountMessage(item.label, language)}: {t.remaining}{' '}
              {Math.max(
                0,
                Math.min(100, item.percentKind === 'remaining' ? item.usedPercent : 100 - item.usedPercent),
              ).toFixed(0)}
              %
              {item.resetsAt
                ? ` · ${new Date(item.resetsAt).toLocaleString(dateLocale)} ${t.resets}`
                : item.resetsText
                  ? ` · ${item.resetsText}`
                  : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>{observation?.error ? accountMessage(observation.error, language) : t.quotaUnknown}</p>
      )}
      {observation && (
        <p className="text-[var(--cafe-text-muted)]">
          {t.observed} · {new Date(observation.observedAt).toLocaleString(dateLocale)} {t.updated}
        </p>
      )}
      {error && <p role="alert">{accountMessage(error, language)}</p>}
    </div>
  );
}
