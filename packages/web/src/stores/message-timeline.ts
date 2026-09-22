export interface MessageTimelinePoint {
  type?: string;
  catId?: string | null;
  origin?: string;
  isStreaming?: boolean;
  timestamp: number;
  deliveredAt?: number;
  timelineOrderAt?: number;
  lifecycle?: {
    kind?: string;
    status?: string;
    completedAt?: number;
  };
}

/** A terminal response is authoritative even if a stale stream flag survives. */
export function isMessageTimelineActive(message: MessageTimelinePoint): boolean {
  if (message.lifecycle?.kind === 'response') return message.lifecycle.status === 'processing';
  return message.isStreaming === true;
}

/** Presentation clock: active streams follow activity; terminal lifecycles freeze at completion. */
export function getMessageTimelineOrderTime(message: MessageTimelinePoint): number {
  const liveOrDeliveryTime = message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
  return isMessageTimelineActive(message) ? liveOrDeliveryTime : (message.lifecycle?.completedAt ?? liveOrDeliveryTime);
}

/** Storage cursor clock: keep browser pagination on the API/Redis timeline score. */
export function getMessageTimelineCursorTime(message: MessageTimelinePoint): number {
  return message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
}
