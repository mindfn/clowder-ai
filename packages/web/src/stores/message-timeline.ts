export interface MessageTimelinePoint {
  type?: string;
  catId?: string | null;
  origin?: string;
  timestamp: number;
  deliveredAt?: number;
  timelineOrderAt?: number;
  lifecycle?: {
    kind?: string;
    status?: string;
    completedAt?: number;
  };
}

/** Presentation clock: active streams follow activity; terminal lifecycles freeze at completion. */
export function getMessageTimelineOrderTime(message: MessageTimelinePoint): number {
  const liveOrDeliveryTime = message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
  return message.lifecycle?.status === 'processing'
    ? liveOrDeliveryTime
    : (message.lifecycle?.completedAt ?? liveOrDeliveryTime);
}

/** Storage cursor clock: keep browser pagination on the API/Redis timeline score. */
export function getMessageTimelineCursorTime(message: MessageTimelinePoint): number {
  return message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
}
