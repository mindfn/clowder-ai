'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountSelection, AccountsResponse, ProfileItem } from '../hub-accounts.types';

export function useAccountDirectory() {
  const [data, setData] = useState<AccountsResponse>();
  const [selection, setSelection] = useState<AccountSelection>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [memberError, setMemberError] = useState('');
  const generation = useRef(0);
  const membersSequence = useRef(0);
  const refresh = useCallback(async () => {
    const observed = ++generation.current;
    const membersRead = ++membersSequence.current;
    const fetchMembers = async () => {
      try {
        const response = await apiFetch('/api/accounts/codex/members', undefined, { afterCurrentGet: true });
        if (!response.ok) throw new Error('成员使用的账号读不到');
        const body = (await response.json()) as { selection?: AccountSelection };
        if (membersRead !== membersSequence.current) return;
        setSelection(body.selection);
        setMemberError(body.selection ? '' : '成员使用的账号读不到');
      } catch {
        if (membersRead === membersSequence.current) {
          setSelection(undefined);
          setMemberError('成员使用的账号读不到');
        }
      }
    };
    void fetchMembers();
    try {
      const response = await apiFetch('/api/accounts', undefined, { afterCurrentGet: true });
      const body = (await response.json()) as AccountsResponse & { error?: string };
      if (observed !== generation.current) return;
      if (!response.ok) throw new Error(body.error ?? '账号列表加载失败');
      setData(body);
      setError('');
    } catch (e) {
      if (observed === generation.current) setError(e instanceof Error ? e.message : '账号列表加载失败');
    } finally {
      if (observed === generation.current) setLoading(false);
    }
  }, []);
  const update = useCallback((profiles: ProfileItem[], removed: string[] = []) => {
    generation.current++;
    setData((current) =>
      current
        ? {
            ...current,
            providers: [
              ...current.providers.filter((p) => !removed.includes(p.id) && !profiles.some((next) => next.id === p.id)),
              ...profiles,
            ],
          }
        : { projectPath: '', providers: profiles },
    );
    setError('');
    setLoading(false);
  }, []);
  const applyBinding = useCallback((next: AccountSelection) => {
    membersSequence.current++;
    setSelection(next);
    setMemberError('');
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const waiting = data?.providers.some((p) =>
    ['preparing', 'queued', 'waiting'].includes(p.codex?.attempt?.state ?? ''),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  useEffect(() => {
    const reconcile = () => {
      void refresh();
    };
    window.addEventListener('accounts-changed', reconcile);
    window.addEventListener('cat-config-changed', reconcile);
    return () => {
      window.removeEventListener('accounts-changed', reconcile);
      window.removeEventListener('cat-config-changed', reconcile);
    };
  }, [refresh]);
  return { data, selection, loading, error, memberError, refresh, update, applyBinding };
}
