'use client';
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalWriteKind } from '@/components/ApprovalHost';
import { apiFetch } from '@/utils/api-client';

type TasteStatus = 'pending' | 'approving' | 'approved' | 'rejected';
/** The original owner-auth status, including recoverable writer claims hidden by the generic lifecycle projection. */
export function useTasteApprovalStatus(item: ApprovalHubItem) {
  const [status, setStatus] = useState<TasteStatus | null>(null);
  const read = useCallback(async (): Promise<TasteStatus | null> => {
    if (item.sourceFeatureId !== 'F221') return null;
    try {
      const response = await apiFetch(
        `/api/taste-proposals/${encodeURIComponent(item.proposalId)}`,
        {},
        { afterCurrentGet: true },
      );
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        !('proposalId' in body) ||
        !('status' in body) ||
        body.proposalId !== item.proposalId
      )
        return null;
      return ['pending', 'approving', 'approved', 'rejected'].includes(String(body.status))
        ? (body.status as TasteStatus)
        : null;
    } catch {
      return null;
    }
  }, [item.proposalId, item.sourceFeatureId]);
  useEffect(() => {
    if (item.sourceFeatureId !== 'F221') return;
    let live = true;
    setStatus(null);
    void read().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, [read, item.sourceFeatureId, item.resolution]);
  const refresh = useCallback(async () => {
    if (item.sourceFeatureId === 'F221') setStatus(await read());
  }, [read, item.sourceFeatureId]);
  const beforeWrite = useCallback(
    async (kind: ApprovalWriteKind) => {
      if (item.sourceFeatureId !== 'F221') return true;
      const current = await read();
      setStatus(current);
      return (current === 'pending' && item.resolution === 'open') || (current === 'approving' && kind === 'approve');
    },
    [read, item.resolution, item.sourceFeatureId],
  );
  return { status, beforeWrite, refresh };
}
