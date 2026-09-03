'use client';

/*
Architecture cell: dispatch
Queue actions consume the existing per-target eligibility and authoritative Queue projection.
*/

import { useCallback, useState } from 'react';
import type { QueueActiveInvocationSlot } from '@/hooks/queue-active-invocation-hydration';
import { reconcileQueueActiveInvocationProjection } from '@/hooks/queue-active-invocation-reconciliation';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409) return '队列状态已更新，请按最新可用操作继续';
  return typeof error === 'string' ? error : 'Steer 失败，请重试';
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const addToast = useToastStore((state) => state.addToast);
  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`);
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (!Array.isArray(data?.queue)) return false;
    setQueue(threadId, data.queue);
    reconcileQueueActiveInvocationProjection({
      threadId,
      slots: data.activeInvocations as QueueActiveInvocationSlot[] | undefined,
      source: 'QueueActionRefresh',
    });
    return true;
  }, [setQueue, threadId]);

  const handleSteerConfirm = useCallback(
    async (targetCatId?: string) => {
      if (!steerEntryId || !targetCatId) return;
      try {
        const response = await apiFetch(`/api/threads/${threadId}/queue/${steerEntryId}/steer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetCatId }),
        });
        if (response.ok) {
          setSteerEntryId(null);
          return;
        }
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          setSteerEntryId(null);
          await refreshQueue();
        }
        addToast({
          type: 'error',
          title: 'Steer 失败',
          message: steerFailureMessage(response.status, data?.code, data?.error),
          threadId,
          duration: 5000,
        });
      } catch {
        addToast({ type: 'error', title: 'Steer 失败', message: 'Steer 失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, refreshQueue, steerEntryId, threadId],
  );

  return {
    steerEntryId,
    handleSteerConfirm,
    handleSteerOpen: setSteerEntryId,
    handleSteerCancel: () => setSteerEntryId(null),
  };
}
