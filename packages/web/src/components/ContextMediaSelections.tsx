'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { removeMediaSelectionFromChat } from './content-review/media-chat-composer';
import { mediaSelectionLabel } from './content-review/media-chat-selection';

/**
 * The places a person circled, as numbered tags. The number is the place's order in the attachment (the same order the
 * canvas marks use), not its stable id, so what the person sees after taking one away stays 1, 2, 3. A place is named
 * by what the person did there (圈选 / 点选), never by coordinates. Only a composer chip, which can be removed at
 * all, offers a per-place remove.
 */
export function ContextMediaSelections({
  attachment,
  compact,
  removable,
}: {
  attachment: MediaContextAttachment;
  compact: boolean;
  removable: boolean;
}) {
  if (attachment.selections.length === 0) return null;
  return (
    <span
      data-testid="media-selections"
      className={`mt-1 flex ${compact ? 'flex-wrap gap-1' : 'flex-col gap-1'} text-micro text-cafe-secondary`}
    >
      {attachment.selections.map((item, index) => (
        <span
          key={item.id}
          data-selection-id={item.id}
          title={compact ? item.instruction : undefined}
          className={`flex min-w-0 items-center gap-1 ${compact ? 'rounded-full border border-cafe-subtle px-1.5 py-0.5' : ''}`}
        >
          <span
            data-testid="media-selection-number"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cafe-subtle bg-cafe-surface-sunken font-semibold"
          >
            {index + 1}
          </span>
          <span className="shrink-0">{mediaSelectionLabel(item)}</span>
          {!compact && item.instruction ? (
            <span className="min-w-0 whitespace-pre-wrap text-xs text-cafe-primary">{item.instruction}</span>
          ) : null}
          {removable ? (
            <button
              type="button"
              aria-label={`移除选区 ${index + 1}`}
              onClick={() => {
                const threadId = useChatStore.getState().currentThreadId;
                if (threadId) removeMediaSelectionFromChat(threadId, attachment.id, item.id);
              }}
              className="rounded p-0.5 text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-secondary"
            >
              <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="m5.7 4.3 4.3 4.3 4.3-4.3 1.4 1.4-4.3 4.3 4.3 4.3-1.4 1.4-4.3-4.3-4.3 4.3-1.4-1.4L8.6 10 4.3 5.7l1.4-1.4Z" />
              </svg>
            </button>
          ) : null}
        </span>
      ))}
    </span>
  );
}
