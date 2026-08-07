/**
 * Phase 4 (AC-H1): Delivery function factory for scheduled task execution.
 * Templates call deliver() to post messages to threads without going through MCP callbacks.
 */
import { randomUUID } from 'node:crypto';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { DeliverOpts, ScheduleLifecycleNotice } from './types.js';

export interface DeliveryDeps {
  /**
   * Real append contract (sol P1 regression 2026-07-23): the previous
   * `append: AnyFn` hid the required `provenance` field from the compiler,
   * so this writer silently violated the write-boundary contract and every
   * scheduled delivery failed at runtime. Typing the real port makes the
   * compiler enforce what the store asserts.
   */
  messageStore: Pick<IMessageStore, 'append'>;
  socketManager: {
    broadcastToRoom(room: string, event: string, data: unknown): void;
    emitToUser(userId: string, event: string, data: unknown): void;
  };
}

export const SCHEDULER_SOURCE = {
  connector: 'scheduler',
  label: '定时任务',
  icon: 'scheduler',
} as const;

export function createDeliverFn(deps: DeliveryDeps): (opts: DeliverOpts) => Promise<string> {
  return async (opts: DeliverOpts): Promise<string> => {
    const stored = await deps.messageStore.append({
      // System-synthesized schedule output; no parser lane runs over it.
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: opts.userId,
      catId: null,
      content: opts.content,
      mentions: [],
      origin: 'callback',
      timestamp: Date.now(),
      threadId: opts.threadId,
      source: SCHEDULER_SOURCE,
      ...(opts.extra ? { extra: opts.extra } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    const schedulerExtra = stored.extra?.scheduler ?? opts.extra?.scheduler;
    deps.socketManager.broadcastToRoom(`thread:${opts.threadId}`, 'connector_message', {
      threadId: opts.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: opts.content,
        source: SCHEDULER_SOURCE,
        ...(schedulerExtra ? { extra: { scheduler: schedulerExtra } } : {}),
        timestamp: stored.timestamp,
      },
    });
    return stored.id;
  };
}

export function createLifecycleToastFn(
  deps: Pick<DeliveryDeps, 'socketManager'>,
): (notice: ScheduleLifecycleNotice) => void {
  return (notice: ScheduleLifecycleNotice): void => {
    deps.socketManager.emitToUser(notice.userId, 'connector_message', {
      threadId: notice.threadId,
      message: {
        id: `scheduler-toast-${Date.now()}-${randomUUID().slice(0, 8)}`,
        type: 'connector',
        content: notice.toast.message,
        source: SCHEDULER_SOURCE,
        extra: { scheduler: { toast: notice.toast } },
        timestamp: Date.now(),
      },
    });
  };
}
