'use client';

import { useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { latestRetryableQueueAttempt } from './queue-retry-action';

interface RetryAction {
  sourceMessageId: string;
  targetId: string;
  attemptId: string;
}

export function projectFailedResponseRetry(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): RetryAction | null {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'response' || lifecycle.status !== 'failed' || !message.replyTo) return null;
  if (!lifecycle.inputMessageIds.includes(message.replyTo)) return null;
  const sources = timelineMessages.filter((candidate) => candidate.id === message.replyTo);
  if (sources.length !== 1) return null;
  const targets =
    sources[0]?.extra?.queueReceipt?.targets.filter((target) => target.catId === lifecycle.targetId) ?? [];
  if (targets.length !== 1) return null;
  const [target] = targets;
  if (!target) return null;
  const attempt = latestRetryableQueueAttempt(target);
  if (!attempt || attempt.targetCatId !== lifecycle.targetId) return null;
  return {
    sourceMessageId: message.replyTo,
    targetId: lifecycle.targetId,
    attemptId: attempt.id,
  };
}

export function FailedResponseRetry({
  message,
  timelineMessages,
}: {
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
}) {
  const action = useMemo(() => projectFailedResponseRetry(message, timelineMessages), [message, timelineMessages]);
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'failed'>('idle');
  if (!action) return null;

  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <button
        type="button"
        data-testid="failed-response-retry"
        disabled={state === 'submitting' || state === 'done'}
        className="rounded-md border border-default px-2 py-1 font-semibold text-primary disabled:opacity-50"
        onClick={() => {
          setState('submitting');
          const sourceMessageId = encodeURIComponent(action.sourceMessageId);
          const targetId = encodeURIComponent(action.targetId);
          void apiFetch(`/api/messages/${sourceMessageId}/queue-targets/${targetId}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attemptId: action.attemptId }),
          })
            .then((response) => setState(response.ok ? 'done' : 'failed'))
            .catch(() => setState('failed'));
        }}
      >
        {state === 'submitting' ? '重试中…' : state === 'done' ? '已提交' : '重试'}
      </button>
      {state === 'failed' ? <span className="text-conn-red-text">重试未提交</span> : null}
    </div>
  );
}
