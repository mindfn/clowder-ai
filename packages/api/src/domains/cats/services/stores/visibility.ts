/**
 * Message Visibility — F35 Whisper + System-user exemption
 * Pure functions for determining whether a message is visible to a given viewer.
 */

import type { CatId } from '@cat-cafe/shared';
import { isDelivered, type StoredMessage } from './ports/MessageStore.js';

/**
 * System-level userIds whose messages are visible to ALL thread participants
 * regardless of the per-user filter (scheduler, system, etc.).
 */
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set(['scheduler', 'system']);

/**
 * Returns true if a message was authored by a trusted system-level source.
 *
 * Historical writes use `catId: 'system'`; newer display-only badges (for example
 * persisted ACP errors) use `catId: null`. Both must bypass per-user filtering.
 */
export function isSystemUserMessage(msg: Pick<StoredMessage, 'userId' | 'catId'>): boolean {
  return SYSTEM_USER_IDS.has(msg.userId) && (msg.catId === 'system' || msg.catId === null);
}

/** Who is viewing */
export type Viewer = { readonly type: 'user' } | { readonly type: 'cat'; readonly catId: CatId };

/**
 * Check if a message is visible to the given viewer.
 *
 * Rules:
 * - User (铲屎官) always sees everything
 * - Public messages (visibility undefined or 'public') are visible to all
 * - Revealed whispers (revealedAt set) are visible to all
 * - Unrevealed whispers are only visible to recipients listed in whisperTo
 */
export function canViewMessage(msg: StoredMessage, viewer: Viewer): boolean {
  if (viewer.type === 'user') return true;

  if (!msg.visibility || msg.visibility === 'public') return true;

  if (msg.visibility === 'whisper') {
    if (msg.revealedAt) return true;
    return msg.whisperTo?.includes(viewer.catId) ?? false;
  }

  return false;
}

/**
 * #699: Unified parent eligibility for reply-to inline preview.
 *
 * A fetched parent message is eligible for inline preview only if it passes
 * the SAME predicates used to build prompt context. This prevents leaking
 * system/undelivered/deleted/whisper/stream content via formatMessage preview.
 *
 * Used by: route-helpers cursor-gap fetch, callbacks replyTo validation.
 */
export interface ReplyParentEligibilityOptions {
  /** Thread the child belongs to — parent must be same thread */
  threadId: string;
  /** Viewer context for whisper visibility */
  viewer: Viewer;
  /** When true, other-cat stream messages are hidden (play mode default) */
  hideOtherCatStreams?: boolean;
  /** The catId of the child message sender — NOT filtered out (own messages are valid parents) */
  childCatId?: CatId | null;
}

export function isEligibleReplyParent(parent: StoredMessage, opts: ReplyParentEligibilityOptions): boolean {
  // Must be same thread
  if (parent.threadId !== opts.threadId) return false;
  // Must be delivered (not queued/canceled)
  if (!isDelivered(parent)) return false;
  // Must not be deleted
  if (parent.deletedAt) return false;
  // System-generated messages are display-only — never valid parents for inline preview
  if (parent.userId === 'system') return false;
  // Briefing messages are non-routing
  if (parent.origin === 'briefing') return false;
  // Whisper visibility
  if (!canViewMessage(parent, opts.viewer)) return false;
  // Play-mode: hide other cats' stream (thinking) messages
  if (opts.hideOtherCatStreams && parent.catId !== null && parent.origin === 'stream') return false;
  return true;
}
