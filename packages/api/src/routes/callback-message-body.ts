import { type MessageContent, serializeContextAttachmentsPrompt } from '@cat-cafe/shared';
import {
  queueSourceTargetState,
  readQueueCarrierMessages,
} from '../domains/cats/services/agents/invocation/QueueCarrierSourceProjection.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage, type Viewer } from '../domains/cats/services/stores/visibility.js';

/** Reader projection of stored attachments; writer admission already owns validation.
 * Do not re-apply today's write budget to a historical source during a full drill. */
export function projectCallbackMessageBody(message: { content: string; contentBlocks?: readonly MessageContent[] }): {
  content: string;
  contentLength: number;
  contentBlocks?: readonly MessageContent[];
} {
  const attachments = message.contentBlocks?.flatMap((block) =>
    block.type === 'context_attachment' ? [block.attachment] : [],
  );
  const content = attachments?.length
    ? [message.content, serializeContextAttachmentsPrompt(attachments)].filter(Boolean).join('\n')
    : message.content;
  return {
    content,
    contentLength: content.length,
    ...(message.contentBlocks?.length ? { contentBlocks: message.contentBlocks } : {}),
  };
}

/** Queue text alone cannot prove that a persisted source's attachments were exposed. */
export async function projectQueuedCallbackMessageBody(
  entry: { entryId: string; content: string; messageId?: string | null; mergedMessageIds?: readonly string[] },
  store: Pick<IMessageStore, 'getById'>,
  scope: { threadId: string; userId: string; catId: string; viewer: Viewer; onSourceError?: (error: unknown) => void },
): Promise<ReturnType<typeof projectCallbackMessageBody> & { sourceUnavailableReason?: string }> {
  const queueBody = projectCallbackMessageBody({ content: entry.content });
  if (!entry.messageId && !entry.mergedMessageIds?.length) {
    return entry.content ? queueBody : { ...queueBody, sourceUnavailableReason: 'queued_body_not_persisted' };
  }
  try {
    const sources = await readQueueCarrierMessages(
      {
        id: entry.entryId,
        threadId: scope.threadId,
        userId: scope.userId,
        messageId: entry.messageId ?? null,
        mergedMessageIds: [...(entry.mergedMessageIds ?? [])],
      },
      store,
    );
    if (
      sources.some((source) => {
        const state = queueSourceTargetState(source, entry.entryId, scope.catId);
        return (
          source.deletedAt ||
          source._tombstone ||
          !canViewMessage(source, scope.viewer) ||
          state === 'retired' ||
          state === 'unknown'
        );
      })
    ) {
      return { ...queueBody, sourceUnavailableReason: 'queued_body_source_changed' };
    }
    return projectCallbackMessageBody({
      content: entry.content,
      contentBlocks: sources.flatMap((source) => source.contentBlocks ?? []),
    });
  } catch (error) {
    scope.onSourceError?.(error);
    // Keep the exact entry/drill visible but withhold full-read evidence. One
    // missing source must not prevent other readable bodies from being returned.
    return { ...queueBody, sourceUnavailableReason: 'queued_body_source_unavailable' };
  }
}
