import type { CatId, CycleRecord } from '@cat-cafe/shared';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export function cycleEvaluationThreadId(objectiveId: string): string {
  return `thread_eval_f257_${objectiveId}`;
}

/** Whether an evaluation wake reached the evaluator, read from the wake message's durable Queue custody. */
export type CycleWakeReceipt =
  | { state: 'pending' }
  | { state: 'delivered'; deliveredAt: number }
  /** Nothing durable will ever report this wake: gone, canceled, or terminal before any exposure. */
  | { state: 'dead' };

/**
 * The receipt is the first exact body exposure: append-only on the custody
 * record, so it survives a restart and no later queue state takes it back.
 * Queue position is not a receipt — a start that fails moves the entry
 * queued → processing → queued without the evaluator ever seeing the wake.
 */
export function resolveCycleWakeReceipt(
  message: Pick<StoredMessage, 'deliveryStatus' | 'queueCustody'> | null | undefined,
): CycleWakeReceipt {
  const custody = message?.queueCustody;
  const exposures = custody?.bodyExposures ?? [];
  if (exposures.length > 0) {
    return { state: 'delivered', deliveredAt: Math.min(...exposures.map((exposure) => exposure.seenAt)) };
  }
  if (!message || !custody || message.deliveryStatus === 'canceled') return { state: 'dead' };
  if (custody.status === 'terminal' || custody.pendingTargetCats.length === 0) return { state: 'dead' };
  return { state: 'pending' };
}

/**
 * The Objective evaluation thread and the wakes sent into it. Split from the
 * coordinator so the cycle state machine and its delivery mechanics each stay
 * readable; the coordinator owns every CycleRecord transition.
 */
export class CycleEvaluationDelivery {
  constructor(
    private readonly deps: {
      runtime: Pick<ObjectiveEvaluationRuntime, 'catalog'>;
      threadStore: IThreadStore;
      deliver: (input: DeliverOpts) => Promise<string>;
      getInvokeTrigger: () => ScheduleInvokeTrigger | null;
      getDefaultCatId: () => CatId;
    },
  ) {}

  async ensureObjectiveThread(objectiveId: string, ownerUserId: string): Promise<{ threadId: string; catId: CatId }> {
    const objective = this.deps.runtime.catalog.registry.objectives.find((item) => item.id === objectiveId);
    if (!objective) throw new Error(`cycle_objective_not_found:${objectiveId}`);
    if (objective.lifecycle === 'retired') throw new Error(`cycle_objective_retired:${objectiveId}`);
    const threadId = cycleEvaluationThreadId(objectiveId);
    await ensureEvalDomainThreads(
      this.deps.threadStore,
      [
        {
          domainId: `f257:${objectiveId}`,
          systemThreadId: threadId,
          displayName: `Harness Objective · ${objective.label}`,
        },
      ],
      ownerUserId,
    );
    const existing = await this.deps.threadStore.get(threadId);
    if (!existing) throw new Error(`cycle_evaluation_thread_missing:${threadId}`);
    const catId = existing.preferredCats?.[0] ?? this.deps.getDefaultCatId();
    if (!existing.preferredCats?.length) await this.deps.threadStore.updatePreferredCats(threadId, [catId]);
    await this.deps.threadStore.addParticipants(threadId, [catId]);
    return { threadId, catId };
  }

  /**
   * Deliver + wake through the Queue even when the thread is idle: a message
   * stored `queued` and force-queued gets durable custody, which is where the
   * delivery receipt comes from. An idle thread starts the entry at once.
   */
  async deliverWake(
    record: CycleRecord,
    threadId: string,
    catId: CatId,
    content: string,
    kind: string,
  ): Promise<string> {
    const messageId = await this.deps.deliver({
      threadId,
      userId: record.ownerUserId,
      content,
      idempotencyKey: this.idempotencyKey(record, kind),
      deliveryStatus: 'queued',
    });
    const trigger = this.deps.getInvokeTrigger();
    if (!trigger) throw new Error('cycle_invoke_trigger_unavailable');
    const outcome = await trigger.trigger(
      threadId,
      catId,
      record.ownerUserId,
      `F257 cycle ${kind}: ${record.cycleId}`,
      messageId,
      undefined,
      { forceQueue: true },
    );
    if (outcome === 'full') throw new Error('cycle_invocation_queue_full');
    return messageId;
  }

  idempotencyKey(record: CycleRecord, kind: string): string {
    // Reject deliberately re-evaluates the same frozen window under the same
    // cycleId. The rejection count is therefore the delivery generation: it
    // deduplicates retries within one attempt without hiding the next
    // assignment (and its operator-provided rejection reason).
    const generation = record.approval?.rejectCount ?? 0;
    return `f257-cycle:${record.ownerUserId}:${record.cycleId}:${kind}:g${generation}`;
  }
}
