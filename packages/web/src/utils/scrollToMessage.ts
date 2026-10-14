import { revealFoldedSourceAnchor } from './folded-source-navigation';

export const MOUNT_DEFERRED_MESSAGE_EVENT = 'cat-cafe:mount-deferred-message';
export const MESSAGE_VIEWPORT_MOUNTED_EVENT = 'cat-cafe:message-viewport-mounted';

export interface MessageScrollAnchor {
  messageId: string;
  viewportOffsetPx: number;
  /** Existing bubble-owner identity; temporary DOM ids may change on finalization. */
  bubbleKey?: string;
  /** Existing timeline-owner score bounds history lookup without retaining a body. */
  timelineOrderAt?: number;
}

function messageBoundaries(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-message-viewport-id]')];
}

/** Project the top visible message into stable identity + viewport-relative geometry. */
export function captureMessageScrollAnchor(container: HTMLElement): MessageScrollAnchor | undefined {
  const viewport = container.getBoundingClientRect();
  const boundary = messageBoundaries(container).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  const messageId = boundary?.dataset.messageViewportId;
  if (!boundary || !messageId) return undefined;
  return {
    messageId,
    viewportOffsetPx: boundary.getBoundingClientRect().top - viewport.top,
  };
}

/** Capture one explicit navigation target without substituting another visible row. */
export function captureMessageScrollAnchorForMessage(
  container: HTMLElement,
  messageId: string,
): MessageScrollAnchor | undefined {
  const target = resolveMessageElements([messageId], container)[0];
  if (!target) return undefined;
  const boundary = target.closest<HTMLElement>('[data-message-viewport-id]') ?? target;
  return {
    messageId,
    viewportOffsetPx: boundary.getBoundingClientRect().top - container.getBoundingClientRect().top,
  };
}

/** Mount deferred targets synchronously, then return their real message nodes in DOM order. */
export function resolveMessageElements(messageIds: Iterable<string>, root: ParentNode = document): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const targetIds = new Set(messageIds);
  if (targetIds.size === 0) return [];

  const mountedIds = new Set(
    [...root.querySelectorAll<HTMLElement>('[data-message-id]')]
      .map((candidate) => candidate.dataset.messageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  const deferredIds = new Set([...targetIds].filter((messageId) => !mountedIds.has(messageId)));
  if (deferredIds.size > 0) {
    for (const placeholder of root.querySelectorAll<HTMLElement>('[data-deferred-message-id]')) {
      const messageId = placeholder.dataset.deferredMessageId;
      if (messageId && deferredIds.has(messageId)) {
        placeholder.dispatchEvent(new Event(MOUNT_DEFERRED_MESSAGE_EVENT));
      }
    }
  }

  return [...root.querySelectorAll<HTMLElement>('[data-message-id]')].filter((candidate) => {
    const messageId = candidate.dataset.messageId;
    return messageId ? targetIds.has(messageId) : false;
  });
}

/** The existing scroll writer accepts the browser's one-pixel quantization; confirmation uses the same contract. */
export function matchesMessageScrollAnchor(container: HTMLElement, anchor: MessageScrollAnchor): boolean {
  const current = captureMessageScrollAnchorForMessage(container, anchor.messageId);
  return current !== undefined && Math.abs(current.viewportOffsetPx - anchor.viewportOffsetPx) <= 1;
}

/** Reapply a saved message anchor after placeholder or content geometry changes. */
export function restoreMessageScrollAnchor(container: HTMLElement, anchor: MessageScrollAnchor): boolean {
  const target = resolveMessageElements([anchor.messageId], container)[0];
  if (!target) return false;
  const boundary = target.closest<HTMLElement>('[data-message-viewport-id]') ?? target;
  const currentOffset = boundary.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const targetTop = Math.max(0, container.scrollTop + currentOffset - anchor.viewportOffsetPx);
  container.scrollTop = targetTop;
  // A mounted row can still sit behind a temporarily short layout. Do not
  // declare restoration complete when the browser clamps the requested offset.
  return Math.abs(container.scrollTop - targetTop) <= 1 && matchesMessageScrollAnchor(container, anchor);
}

const messageHighlights = new WeakMap<HTMLElement, () => void>();

/** Start a complete highlight interval on the resolved target, scoped to this activation. */
export function highlightMessage(messageId: string, root: ParentNode = document): (() => void) | undefined {
  const el = resolveMessageElements([messageId], root)[0];
  if (!el) return undefined;
  messageHighlights.get(el)?.();
  const clear = () => {
    clearTimeout(timer);
    if (messageHighlights.get(el) !== clear) return;
    messageHighlights.delete(el);
    el.classList.remove('ring-2', 'ring-blue-400');
  };
  el.classList.add('ring-2', 'ring-blue-400', 'transition-all');
  const timer = setTimeout(clear, 1500);
  messageHighlights.set(el, clear);
  return clear;
}

/**
 * Scroll to a message by ID with smooth animation and temporary highlight.
 * Returns true when the target element was found (so callers can retry on a
 * raf loop until the message DOM has rendered after a thread switch).
 */
export function scrollToMessage(
  messageId: string,
  root: ParentNode = document,
  behavior: ScrollBehavior = 'smooth',
  highlight = true,
): boolean {
  const el = resolveMessageElements([messageId], root)[0];
  if (!el) return false;

  revealFoldedSourceAnchor(el);
  // The owner passes its reading viewport. Default-document callers use the
  // nearest scrolling ancestor, so a tall reply never hides its author header.
  let viewport = root instanceof HTMLElement ? root : el.parentElement;
  while (viewport && !(root instanceof HTMLElement) && !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY))
    viewport = viewport.parentElement;
  const viewportHeight = viewport?.clientHeight ?? document.documentElement.clientHeight;
  const block = el.getBoundingClientRect().height > viewportHeight && viewportHeight > 0 ? 'start' : 'center';
  el.scrollIntoView({ behavior, block });

  if (highlight) {
    messageHighlights.get(el)?.();
    el.classList.add('ring-2', 'ring-blue-400', 'transition-all');
    setTimeout(() => {
      // A later owner-settled activation must receive its own full interval.
      if (!messageHighlights.has(el)) el.classList.remove('ring-2', 'ring-blue-400');
    }, 1500);
  }
  return true;
}
