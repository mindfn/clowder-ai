'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubAccountItem, type ProfileEditPayload } from './HubAccountItem';
import type { AccountsResponse, ProfileItem } from './hub-accounts.types';
import { normalizeBuiltinClientIds, resolveAccountActionId } from './hub-accounts.view';
import { type UnifiedAuthEditData, UnifiedAuthModal } from './UnifiedAuthModal';

export function HubAccountsTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [editTarget, setEditTarget] = useState<UnifiedAuthEditData | undefined>(undefined);

  const fetchAccounts = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/accounts');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((body.error as string) ?? '加载失败');
        return;
      }
      const body = (await res.json()) as AccountsResponse;
      setData(body);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAccounts();
  }, [fetchAccounts]);

  const callApi = useCallback(async (path: string, init: RequestInit) => {
    const res = await apiFetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body.error as string) ?? `请求失败 (${res.status})`);
    }
    return body;
  }, []);

  const handleAuthCreated = useCallback(async () => {
    setShowAuthModal(false);
    setEditTarget(undefined);
    await fetchAccounts();
    window.dispatchEvent(new CustomEvent('accounts-changed'));
  }, [fetchAccounts]);

  const handleEdit = useCallback((profile: ProfileItem) => {
    setEditTarget({
      id: resolveAccountActionId(profile),
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      clientId: profile.clientId,
      authType: profile.authType,
      models: profile.models,
      envVars: profile.envVars,
    });
    setShowAuthModal(true);
  }, []);

  const deleteAccount = useCallback(
    async (accountId: string) => {
      setBusyId(accountId);
      setError(null);
      try {
        await callApi(`/api/accounts/${accountId}`, { method: 'DELETE' });
        await fetchAccounts();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchAccounts],
  );

  const saveAccount = useCallback(
    async (accountId: string, payload: ProfileEditPayload) => {
      setBusyId(accountId);
      setError(null);
      try {
        await callApi(`/api/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await fetchAccounts();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchAccounts],
  );

  const displayAccounts = useMemo(() => normalizeBuiltinClientIds(data?.providers ?? []), [data?.providers]);
  const builtinAccounts = useMemo(() => displayAccounts.filter((a) => a.builtin), [displayAccounts]);
  const customAccounts = useMemo(() => displayAccounts.filter((a) => !a.builtin), [displayAccounts]);
  const displayCards = useMemo(() => [...builtinAccounts, ...customAccounts], [builtinAccounts, customAccounts]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;
  if (!data)
    return (
      <div className="flex flex-col items-center justify-center rounded-[28px] bg-[var(--console-card-bg)] py-16 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--console-card-soft-bg)]">
          <svg
            className="h-8 w-8 text-cafe-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-cafe-secondary">暂无账号数据</h3>
        <p className="mt-1 max-w-[220px] text-xs text-cafe-muted">无法加载账号列表，请检查服务连接后刷新重试</p>
      </div>
    );

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex items-start justify-between gap-3 px-1">
        <div>
          <p className="text-[13px] font-semibold text-[#E29578]">系统配置 &gt; 账号配置</p>
          <p className="mt-1 text-[13px] leading-6 text-[#8A776B]">
            每个账号可添加或删除模型。账号配置全局共享，所有项目通用。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditTarget(undefined);
            setShowAuthModal(true);
          }}
          className="shrink-0 rounded-full bg-[#D49266] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#c47f52] transition"
        >
          + 新增账户认证
        </button>
      </div>

      <div role="group" aria-label="Account List" className="space-y-4" data-guide-id="accounts.account-list">
        {displayCards.map((account) => (
          <HubAccountItem
            key={account.id}
            profile={account}
            busy={busyId === resolveAccountActionId(account)}
            onSave={(_id, payload) => saveAccount(resolveAccountActionId(account), payload)}
            onDelete={() => deleteAccount(resolveAccountActionId(account))}
            onEdit={handleEdit}
          />
        ))}
      </div>

      <p className="text-[13px] text-[#B59A88]">点击卡片进入编辑 →</p>
      <p className="text-xs leading-5 text-[#B59A88]">
        secrets 存储在启动目录下 `.cat-cafe/credentials.json`，Git 忽略。
      </p>

      <UnifiedAuthModal
        key={editTarget?.id ?? 'create'}
        open={showAuthModal}
        onClose={() => {
          setShowAuthModal(false);
          setEditTarget(undefined);
        }}
        onCreated={handleAuthCreated}
        editProfile={editTarget}
      />
    </div>
  );
}
