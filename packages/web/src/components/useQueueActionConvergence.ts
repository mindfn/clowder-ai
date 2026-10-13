'use client';

/*
Architecture cell: dispatch
Queue actions consume per-target eligibility joined onto the authoritative source-entry Queue projection.
*/

import { useCallback, useState } from 'react';
import type { QueueActiveInvocationSlot } from '@/hooks/queue-active-invocation-hydration';
import { reconcileQueueActiveInvocationProjection } from '@/hooks/queue-active-invocation-reconciliation';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { queuedGuidanceCopy } from './execution-row/queue-toast-copy';
import type { SteerSubmission } from './SteerQueuedEntryModal';

function steerFailureMessage(status: number, code: unknown, error: unknown): string {
  if (code === 'ENTRY_PROCESSING') return '该消息正在处理，已刷新最新队列';
  if (status === 409 && (code === 'CONTINUE_STATE_CHANGED' || code === 'STEER_ENTRY_UNAVAILABLE')) {
    return '队列状态已更新，请按最新可用操作继续';
  }
  return typeof error === 'string' ? error : 'Steer 失败，请重试';
}

interface MappedSteerTarget {
  entryId: string;
  targetCatId: string;
  strategy: 'guide_reply' | 'interrupt_reply';
}

async function submitMappedSteerTargets(threadId: string, targets: MappedSteerTarget[]) {
  const failures: string[] = [];
  const queuedTargets: Array<{ entryId: string; targetCatId: string }> = [];
  const unconfirmedInterrupts: string[] = [];
  for (const target of targets) {
    const route = target.strategy === 'guide_reply' ? 'continue' : 'steer';
    const response = await apiFetch(`/api/threads/${threadId}/queue/${target.entryId}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: target.targetCatId }),
    }).catch(() => null);
    if (!response) {
      // /targets already persisted the intent and woke ordinary drain. A lost
      // follow-up cannot undo that acceptance, or prevent the other targets.
      if (target.strategy === 'guide_reply') queuedTargets.push(target);
      else unconfirmedInterrupts.push(target.targetCatId);
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      if (data?.outcome === 'queued') queuedTargets.push(target);
      continue;
    }
    if (response.status === 404 || data?.code === 'ENTRY_PROCESSING' || data?.code === 'ENTRY_NOT_FOUND') {
      continue;
    }
    failures.push(`${target.targetCatId}: ${steerFailureMessage(response.status, data?.code, data?.error)}`);
  }
  return { failures, queuedTargets, unconfirmedInterrupts };
}

function queuedGuidanceFeedback(
  threadId: string,
  targets: Array<{ entryId: string; targetCatId: string }>,
  refreshed: boolean,
): { title: string; message: string } | undefined {
  if (targets.length === 0) return;
  if (!refreshed)
    return {
      title: '发送请求已保存',
      message: '队列刷新未完成，尚未确认消息是否投递；请刷新查看最新状态。',
    };
  const current = useChatStore.getState().getThreadState(threadId);
  const messages = targets.flatMap(({ entryId, targetCatId }) => {
    const entry = current.queue.find(
      (item) => item.id === entryId && item.status === 'queued' && item.targetCats.includes(targetCatId),
    );
    if (!entry) return [];
    const intent = entry.authorIntentByTarget?.[targetCatId];
    const invocation = current.catInvocations[targetCatId];
    const lifecycle =
      intent?.boundParentInvocationId === invocation?.invocationId ? invocation?.appServerLifecycle : undefined;
    return [queuedGuidanceCopy(intent?.effective, intent?.fallbackReason, lifecycle?.turnAccepted)];
  });
  if (messages.length === 0) return;
  return { title: '引导请求已保存', message: [...new Set(messages)].join('；') };
}

export function useQueueActionConvergence(threadId: string) {
  const setQueue = useChatStore((state) => state.setQueue);
  const addToast = useToastStore((state) => state.addToast);
  const [steerEntryId, setSteerEntryId] = useState<string | null>(null);

  const refreshQueue = useCallback(async () => {
    const response = await apiFetch(`/api/threads/${threadId}/queue`).catch(() => null);
    if (!response?.ok) return false;
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
    async ({ sourceRecordId, observedPendingTargetIds, actions }: SteerSubmission) => {
      if (!steerEntryId || !sourceRecordId || actions.length === 0) return;
      try {
        const mappingResponse = await apiFetch(`/api/threads/${threadId}/queue/${steerEntryId}/targets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceRecordId,
            observedPendingTargetIds,
            targets: actions.map((action) => ({
              targetCatId: action.targetId,
              strategy: action.strategy,
              membershipAtOpen: action.membershipAtOpen,
            })),
          }),
        });
        const mapping = await mappingResponse.json().catch(() => ({}));
        if (!mappingResponse.ok || !Array.isArray(mapping?.targets)) {
          if (mappingResponse.status === 409) {
            setSteerEntryId(null);
            await refreshQueue();
          }
          addToast({
            type: 'error',
            title: 'Steer 失败',
            message: steerFailureMessage(mappingResponse.status, mapping?.code, mapping?.error),
            threadId,
            duration: 5000,
          });
          return;
        }

        const { failures, queuedTargets, unconfirmedInterrupts } = await submitMappedSteerTargets(
          threadId,
          mapping.targets,
        );
        setSteerEntryId(null);
        const refreshed = await refreshQueue();
        if (failures.length > 0) {
          addToast({
            type: 'error',
            title: '部分 Steer 未完成',
            message: failures.join('；'),
            threadId,
            duration: 5000,
          });
        }
        const feedback = queuedGuidanceFeedback(threadId, queuedTargets, refreshed);
        if (feedback) addToast({ type: 'info', ...feedback, threadId, duration: 5000 });
        if (unconfirmedInterrupts.length > 0) {
          addToast({
            type: 'info',
            title: '发送请求已保存',
            message: `${unconfirmedInterrupts.join('、')}：尚未确认中断请求的结果；请查看当前回复和队列状态。`,
            threadId,
            duration: 5000,
          });
        }
      } catch {
        addToast({ type: 'error', title: 'Steer 失败', message: 'Steer 失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, refreshQueue, steerEntryId, threadId],
  );

  return {
    refreshQueue,
    steerEntryId,
    handleSteerConfirm,
    handleSteerOpen: setSteerEntryId,
    handleSteerCancel: () => setSteerEntryId(null),
  };
}
