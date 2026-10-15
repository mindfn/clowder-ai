'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { expandMessageExecutionRecord } from '@/components/message-disclosure-state';
import { requestExecutionDetail } from '@/components/workspace-home/execution-detail-request';
import { selectThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';

/** An activation rechecks the canonical identity; neither a parent nor a newer reply is a target. */
export function locateExecution(execution: ActiveExecutionProjection): 'opened' | 'pending' | 'unavailable' {
  const current = useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)];
  if (!current || current.startedAt !== execution.startedAt || current.turnInvocationId !== execution.turnInvocationId)
    return 'unavailable';
  if (current.kind === 'managed_command') {
    if (useChatStore.getState().presentationLock) return 'unavailable';
    requestExecutionDetail(current);
    return 'pending';
  }
  if (!current.turnInvocationId) return 'unavailable';
  const chat = useChatStore.getState();
  const message = selectThreadMessages(chat, current.threadId).find(
    (item) =>
      item.catId === current.catId &&
      item.isStreaming &&
      (item.lifecycle?.kind === 'response'
        ? item.lifecycle.invocationId
        : (item.extra?.stream?.turnInvocationId ?? item.extra?.stream?.invocationId)) === current.turnInvocationId,
  );
  if (!message) return 'unavailable';
  expandMessageExecutionRecord(current.threadId, message);
  // The row belongs to the displayed conversation (also in split Chat). Its original deferred-message
  // owner can mount a known target through scrollToMessage; an unreadable target gets explicit feedback.
  return scrollToMessage(message.id) ? 'opened' : 'unavailable';
}
