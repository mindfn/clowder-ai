'use client';

import type { ContextAttachment, LifecycleAppendAction, MessageWorkDisposition } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { useChatCommands } from '@/hooks/useChatCommands';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

export type UploadStatus = 'idle' | 'uploading' | 'failed';

export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

export type PostAdmissionAction = 'steer' | 'append';

interface MessageAdmissionResponse {
  status?: string;
  entryId?: string;
  gameThreadId?: string;
}

/**
 * Submit one durable Queue input. History and active-invocation UI are projected
 * exclusively from lifecycle events after server admission; this hook never creates
 * an optimistic History bubble or a client-owned invocation.
 */
export function useSendMessage(activeThreadId?: string) {
  const addMessageToThread = useChatStore((state) => state.addMessageToThread);
  const { processCommand } = useChatCommands();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const createClientId = useCallback((): string => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

    const randomHex = (length: number) =>
      Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    return [
      randomHex(8),
      randomHex(4),
      `4${randomHex(3)}`,
      `${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${randomHex(3)}`,
      randomHex(12),
    ].join('-');
  }, []);

  const publishError = useCallback(
    (threadId: string, content: string) => {
      const message: ChatMessageData = {
        id: `err-${Date.now()}`,
        type: 'system',
        variant: 'error',
        content,
        timestamp: Date.now(),
      };
      addMessageToThread(threadId, message);
    },
    [addMessageToThread],
  );

  const steerAcceptedEntry = useCallback(
    async (threadId: string, entryId: string): Promise<void> => {
      try {
        const response = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/steer`, { method: 'POST' });
        if (response.ok) return;
        const body = await response.json().catch(() => null);
        publishError(threadId, `消息已进入队列，但 Steer 未执行：${body?.error ?? `Server error: ${response.status}`}`);
      } catch (error) {
        publishError(
          threadId,
          `消息已进入队列，但 Steer 未执行：${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
    [publishError],
  );

  const appendAcceptedEntry = useCallback(
    async (threadId: string, entryId: string): Promise<void> => {
      try {
        const queueResponse = await apiFetch(`/api/threads/${threadId}/queue`);
        if (!queueResponse.ok) throw new Error(`Server error: ${queueResponse.status}`);
        const snapshot = (await queueResponse.json()) as {
          queue?: Array<{ id?: string; lifecycleActions?: { append?: LifecycleAppendAction } }>;
        };
        const action = snapshot.queue?.find((entry) => entry.id === entryId)?.lifecycleActions?.append;
        if (!action) {
          publishError(threadId, '消息已进入队列，但当前回复已不再接受追加；消息将按队列继续处理。');
          return;
        }
        const response = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/append`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedQueueRevision: action.expectedQueueRevision,
            expectedRuns: action.expectedRuns,
          }),
        });
        if (response.ok) return;
        const body = await response.json().catch(() => null);
        publishError(
          threadId,
          `消息已进入队列，但未能追加到当前回复：${body?.error ?? `Server error: ${response.status}`}`,
        );
      } catch (error) {
        publishError(
          threadId,
          `消息已进入队列，但未能追加到当前回复：${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
    [publishError],
  );

  const handleSend = useCallback(
    async (
      content: string,
      images?: File[],
      overrideThreadId?: string,
      whisper?: WhisperOptions,
      postAdmissionAction?: PostAdmissionAction,
      replyToId?: string,
      messageDisposition?: MessageWorkDisposition,
      contextAttachments?: ContextAttachment[],
      explicitTargetCats?: string[],
    ) => {
      const threadId = overrideThreadId ?? activeThreadId ?? useChatStore.getState().currentThreadId;
      const hasImages = Boolean(images?.length);
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = await processCommand(content, threadId);
      if (wasCommand) return false;

      const clientMessageId = createClientId();

      try {
        let response: Response;
        if (hasImages) {
          const formData = new FormData();
          formData.append('content', content);
          formData.append('threadId', threadId);
          formData.append('idempotencyKey', clientMessageId);
          if (messageDisposition) formData.append('messageDisposition', messageDisposition);
          for (const catId of explicitTargetCats ?? []) formData.append('mentions', catId);
          if (whisper) {
            formData.append('visibility', whisper.visibility);
            for (const catId of whisper.whisperTo) formData.append('whisperTo', catId);
          }
          if (replyToId) formData.append('replyTo', replyToId);
          if (contextAttachments?.length) {
            formData.append('contextAttachments', JSON.stringify(contextAttachments));
          }
          for (const image of images ?? []) formData.append('images', image);
          response = await apiFetch('/api/messages', { method: 'POST', body: formData });
        } else {
          response = await apiFetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              threadId,
              idempotencyKey: clientMessageId,
              ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
              ...(replyToId ? { replyTo: replyToId } : {}),
              ...(messageDisposition ? { messageDisposition } : {}),
              ...(explicitTargetCats?.length ? { mentions: explicitTargetCats } : {}),
              ...(contextAttachments?.length ? { contextAttachments } : {}),
            }),
          });
        }

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail ?? body?.error ?? `Server error: ${response.status}`);
        }

        const admission = (await response.json().catch(() => null)) as MessageAdmissionResponse | null;
        if (admission?.status !== 'game_started' && admission?.status !== 'queued') {
          throw new Error('Server did not return a canonical Queue admission');
        }
        if (postAdmissionAction === 'steer') {
          if (!admission.entryId) throw new Error('Steer admission did not return an exact Queue entry');
          await steerAcceptedEntry(threadId, admission.entryId);
        } else if (postAdmissionAction === 'append') {
          if (!admission.entryId) throw new Error('Append admission did not return an exact Queue entry');
          await appendAcceptedEntry(threadId, admission.entryId);
        }

        setUploadStatus('idle');
        setUploadError(null);
        window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (hasImages) {
          setUploadStatus('failed');
          setUploadError(errorMessage);
        } else {
          setUploadStatus('idle');
        }
        publishError(threadId, `Failed to send message: ${errorMessage}`);
        return false;
      }
    },
    [activeThreadId, appendAcceptedEntry, createClientId, processCommand, publishError, steerAcceptedEntry],
  );

  return { handleSend, uploadStatus, uploadError };
}
