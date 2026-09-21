/**
 * Phase 4 (AC-H1): Delivery function factory for scheduled task execution.
 * Templates call deliver() to post messages to threads without going through MCP callbacks.
 */
import { randomUUID } from 'node:crypto';
import { normalizeOwnerAuthProvenance } from '../../domains/cats/services/owner-auth-provenance.js';
import type { DeliverOpts, ScheduleLifecycleNotice } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export interface DeliveryDeps {
  messageStore: { append: AnyFn };
  socketManager: { broadcastToRoom: AnyFn; emitToUser: AnyFn };
  /** RFC §5.1: the one component that turns a producer envelope into durable Queue work. */
  persistedQueueDelivery?: import('../../domains/cats/services/agents/invocation/PersistedQueueDelivery.js').PersistedQueueDeliveryPort;
}

export const SCHEDULER_SOURCE = {
  connector: 'scheduler',
  label: '定时任务',
  icon: 'scheduler',
} as const;

/** RFC §5.4: admit a target-only payload — same Queue and drain, no public History member. */
export function createDeliverPrivateFn(
  deps: Pick<DeliveryDeps, 'persistedQueueDelivery'>,
): (opts: import('./types.js').PrivateDeliverOpts) => Promise<void> {
  return async (opts): Promise<void> => {
    if (!deps.persistedQueueDelivery) throw new Error('scheduler private Queue admission requires a delivery port');
    const admitted = await deps.persistedQueueDelivery.deliverPrivate({
      ownerUserId: opts.userId,
      threadId: opts.threadId,
      targetCatId: opts.targetCatId,
      idempotencyKey: opts.idempotencyKey,
      content: opts.content,
      from: { kind: 'system', service: SCHEDULER_SOURCE.connector },
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
      ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
    });
    if (!admitted.admitted) throw new Error('scheduler private Queue admission did not happen');
  };
}

export function createDeliverFn(deps: DeliveryDeps): (opts: DeliverOpts) => Promise<string> {
  /** A message the thread should show and no member must act on: History only, never a Queue row. */
  const publishVisible = async (opts: DeliverOpts, source: DeliverOpts['source'] & object): Promise<string> => {
    const stored = await deps.messageStore.append({
      from: { kind: 'system', service: source.connector },
      userId: opts.userId,
      content: opts.content,
      mentions: [],
      origin: 'callback',
      timestamp: Date.now(),
      threadId: opts.threadId,
      source,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
    });
    const schedulerExtra = stored.extra?.scheduler ?? opts.extra?.scheduler;
    deps.socketManager.broadcastToRoom(`thread:${opts.threadId}`, 'connector_message', {
      threadId: opts.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: typeof stored.content === 'string' ? stored.content : opts.content,
        source,
        ...(schedulerExtra ? { extra: { scheduler: schedulerExtra } } : {}),
        timestamp: stored.timestamp,
      },
    });
    return stored.id;
  };

  return async (opts: DeliverOpts): Promise<string> => {
    const source = opts.source ?? SCHEDULER_SOURCE;

    // A scheduled input that needs a member to act is the same `conversation_input` envelope a user
    // send builds. One transaction persists it and admits it; Queue drain owes the wake. Producers
    // never append a hidden source and bind it afterwards, so there is no window to compensate for.
    if (opts.targetCatId) {
      if (!deps.persistedQueueDelivery) throw new Error('scheduler Queue admission requires a delivery port');
      if (!opts.idempotencyKey) throw new Error('scheduler Queue admission requires a stable idempotencyKey');

      // When the target's exact input differs from what the thread should show, the public line is
      // an ordinary History-only message and the payload is a `private_input` Queue entry. Both are
      // still one Queue, one drain — the split is in visibility, never in the reliability path.
      if (opts.privateContent !== undefined) {
        const publicId = await publishVisible(opts, source);
        const privateAdmission = await deps.persistedQueueDelivery.deliverPrivate({
          ownerUserId: opts.userId,
          threadId: opts.threadId,
          targetCatId: opts.targetCatId,
          idempotencyKey: `${opts.idempotencyKey}:private`,
          content: opts.privateContent,
          from: { kind: 'system', service: source.connector },
          ...(opts.priority ? { priority: opts.priority } : {}),
          ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
          ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
        });
        if (!privateAdmission.admitted) throw new Error('scheduler private Queue admission did not happen');
        return publicId;
      }

      const admitted = await deps.persistedQueueDelivery.deliver({
        ownerUserId: opts.userId,
        threadId: opts.threadId,
        targetCatId: opts.targetCatId,
        idempotencyKey: opts.idempotencyKey,
        content: opts.content,
        source,
        from: { kind: 'system', service: source.connector },
        ...(opts.extra ? { extra: opts.extra as never } : {}),
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.suggestedSkill ? { suggestedSkill: opts.suggestedSkill } : {}),
        ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
        // Never inherit the producer-default: an ordinary scheduled wake carries an authenticated
        // owner but NOT a private managed-hold continuation proof. Only hold-ball may project strict.
        ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
      });
      if (admitted.state === 'conflict' || admitted.state === 'unavailable') {
        throw new Error(`scheduler Queue admission did not happen: ${admitted.state}`);
      }
      return admitted.message?.id ?? '';
    }

    const stored = await deps.messageStore.append({
      from: { kind: 'system', service: source.connector },
      userId: opts.userId,
      content: opts.content,
      mentions: [],
      origin: 'callback',
      timestamp: Date.now(),
      threadId: opts.threadId,
      source,
      ...(opts.deliveryStatus ? { deliveryStatus: opts.deliveryStatus } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
    });
    if (opts.deliveryStatus === 'queued') return stored.id;
    const schedulerExtra = stored.extra?.scheduler ?? opts.extra?.scheduler;
    deps.socketManager.broadcastToRoom(`thread:${opts.threadId}`, 'connector_message', {
      threadId: opts.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: typeof stored.content === 'string' ? stored.content : opts.content,
        source,
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
