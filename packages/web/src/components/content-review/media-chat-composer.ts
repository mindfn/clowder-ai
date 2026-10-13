import type { ArtifactReviewAnchor, MediaContextAttachment } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { composerAttachments, queuedServerAckBlocks } from '../composer-queue';
import {
  type AddMediaSelection,
  type AddMediaWork,
  addMediaSelection,
  addMediaWork,
  type MediaChatTarget,
  pendingMediaAttachment,
  removeMediaSelection,
} from './media-chat-selection';

/**
 * Where circled places on an image enter the one chat composer. Like a text selection, it only lands in that
 * conversation's input as a chip: it never sends, delegates or records anything. The decision about what the
 * media attachment becomes is `media-chat-selection`; this only reads the composer and queues the change.
 */

export { composerAttachments };

/**
 * Queues one change to the media attachment. A change to an attachment the composer already holds is a replace in
 * place (the same id, plus its id in the remove list), exactly as other chips are edited; anything else already queued
 * for this conversation on the same tick is kept.
 */
function queueMediaChange(
  threadId: string,
  attachmentId: string,
  next: MediaContextAttachment | null,
  replacing: boolean,
): void {
  const queued = useChatStore.getState().pendingChatInsert;
  const base = queued && queued.threadId === threadId ? queued : { threadId, text: '' };
  const removed = new Set(base.removeContextAttachmentIds ?? []);
  if (replacing) removed.add(attachmentId);
  useChatStore.getState().setPendingChatInsert({
    ...base,
    contextAttachments: [
      ...(base.contextAttachments ?? []).filter((attachment) => attachment.id !== attachmentId),
      ...(next ? [next] : []),
    ],
    ...(removed.size ? { removeContextAttachmentIds: [...removed] } : {}),
  });
}

export type AddMediaSelectionToChat = AddMediaSelection | { readonly kind: 'refused'; readonly reason: 'no_thread' };

export function addMediaWorkToChat(
  threadId: string | null,
  target: MediaChatTarget,
): AddMediaWork | { readonly kind: 'refused'; readonly reason: 'no_thread' } {
  if (!threadId) return { kind: 'refused', reason: 'no_thread' };
  if (queuedServerAckBlocks()) return { kind: 'refused', reason: 'recall_pending' };
  const current = composerAttachments(threadId);
  const result = addMediaWork(current, target);
  if (result.kind === 'added')
    queueMediaChange(threadId, result.attachment.id, result.attachment, pendingMediaAttachment(current) !== undefined);
  return result;
}

export function addMediaSelectionToChat(
  threadId: string | null,
  target: MediaChatTarget,
  anchor: ArtifactReviewAnchor,
  instruction?: string,
): AddMediaSelectionToChat {
  if (!threadId) return { kind: 'refused', reason: 'no_thread' };
  // A recall's answer waiting for the input is not something a place can be added to, or take the slot from: the input
  // would take the place as already saved. Nothing is queued, so nothing is lost; the person adds it again a moment
  // later.
  if (queuedServerAckBlocks()) return { kind: 'refused', reason: 'recall_pending' };
  const current = composerAttachments(threadId);
  const result = addMediaSelection(current, target, anchor, instruction);
  if (result.kind === 'added')
    queueMediaChange(threadId, result.attachment.id, result.attachment, pendingMediaAttachment(current) !== undefined);
  return result;
}

/**
 * Takes one place out of the attachment that shows it. The attachment is named by id, never assumed to be the first
 * media attachment of the composer: a draft can hold more than one, and a place belongs to the one it is shown on.
 */
export function removeMediaSelectionFromChat(threadId: string, attachmentId: string, selectionId: string): void {
  const attachment = composerAttachments(threadId).find(
    (item): item is MediaContextAttachment => item.kind === 'media' && item.id === attachmentId,
  );
  if (!attachment) return;
  const next = removeMediaSelection(attachment, selectionId);
  if (next === attachment) return;
  // Reachable only while the input is not taking what is queued for it; changing a recall's answer is never done.
  if (queuedServerAckBlocks()) return;
  queueMediaChange(threadId, attachment.id, next, true);
}
