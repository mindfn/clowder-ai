import type { StoredMessage } from './ports/MessageStore.js';

/** Fields required to reproduce a persisted message's timeline order without hydrating its history payload. */
export type TimelineOrderMessage = Pick<
  StoredMessage,
  'userId' | 'catId' | 'timestamp' | 'deliveredAt' | 'timelineOrderAt' | 'deliveryStatus' | 'origin'
> & {
  source?: unknown;
  queueCustody?: unknown;
};

export function isDeliveredMessage(message: StoredMessage): boolean {
  return !message.deliveryStatus || message.deliveryStatus === 'delivered';
}

export function isRealCatSpeech(message: TimelineOrderMessage): boolean {
  return (
    message.catId !== null &&
    message.catId !== 'system' &&
    message.userId !== 'system' &&
    message.userId !== 'scheduler' &&
    message.origin !== 'briefing'
  );
}

export function isQueuedCatTimelineMessage(message: TimelineOrderMessage): boolean {
  return message.deliveryStatus === 'queued' && isRealCatSpeech(message);
}

/**
 * Owner-facing timeline publication for durable queued user work. This is kept
 * separate from `isTimelinePublished`: callback/context/prompt readers must not
 * learn an undelivered body merely because the browser can render its receipt.
 */
export function isQueuedUserTimelineMessage(message: TimelineOrderMessage): boolean {
  if (
    message.deliveryStatus !== 'queued' ||
    message.catId !== null ||
    message.source !== undefined ||
    message.userId === 'system' ||
    message.userId === 'scheduler' ||
    message.origin === 'briefing'
  ) {
    return false;
  }
  return message.queueCustody !== undefined;
}

/**
 * Host-attributed connector ingress is already an owner-visible receipt at
 * admission. Keep it browser-only until delivery just like queued user work:
 * prompt/context readers must not learn it through `isTimelinePublished`, but
 * the owner must see the source bubble before the target cat starts replying.
 * System/scheduler connectors remain behind their dedicated visibility gates.
 */
export function isQueuedOwnerConnectorTimelineMessage(message: TimelineOrderMessage): boolean {
  return (
    message.deliveryStatus === 'queued' &&
    message.catId === null &&
    message.source !== undefined &&
    message.userId !== 'system' &&
    message.userId !== 'scheduler' &&
    message.origin !== 'briefing' &&
    message.queueCustody !== undefined
  );
}

export function isOwnerVisibleRecalledUserMessage(message: StoredMessage): boolean {
  return (
    message.deliveryStatus === 'canceled' &&
    message.catId === null &&
    message._tombstone === true &&
    message.recall?.exposure === 'seen'
  );
}
