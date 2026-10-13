import type { QueuedMessageCustody } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';

/** A durable lane discriminator, never authority. No started attempt can be replayed here. */
export function isUnstartedTaskCustody(c: QueuedMessageCustody, target: string): boolean {
  const histories = [
    c.failedByCatIds,
    c.handledByCatIds,
    c.withdrawnByCatIds,
    c.steerRequestedByCatIds,
    c.seenByCatIds,
  ];
  const witnesses = [
    c.awakenedInvocationIdByCatId,
    c.awakenedAtByCatId,
    c.seenInvocationIdByCatId,
    c.steeredInvocationIdByCatId,
    c.targetOutcomeByCatId,
  ];
  return !(
    c.sourceCategory !== 'plugin_task' ||
    c.status !== 'queued' ||
    c.processingStartedAt !== undefined ||
    c.receiptScope !== undefined ||
    c.authorIntentByCatId !== undefined ||
    c.carrierByTargetCatId !== undefined ||
    c.carrierStateByTargetCatId !== undefined ||
    c.prestartRetirement ||
    histories.some((v) => v?.some((id) => id === target)) ||
    witnesses.some((v) => v?.[target] !== undefined) ||
    c.bodyExposures?.length ||
    c.readEvidenceWitnesses?.length ||
    (c.targetAttempts ?? []).length > 1 ||
    (c.targetAttempts ?? []).some(
      (a) =>
        a.targetCatId !== target ||
        a.state !== 'queued' ||
        a.sequence !== 1 ||
        a.invocationId !== undefined ||
        a.seenAt !== undefined ||
        a.terminalReason !== undefined,
    )
  );
}

export function assertUnstartedTaskCustody(c: QueuedMessageCustody, target: string): void {
  if (!isUnstartedTaskCustody(c, target)) throw new Error('Host Task Queue custody rejected');
}

/** This marker excludes ordinary scheduling; durable Host re-reading remains the authority. */
export function assertTaskQueueEntry(entry: QueueEntry): void {
  if (
    entry.sourceCategory !== 'plugin_task' ||
    entry.pluginPublicInvocation !== undefined ||
    entry.source !== 'user' ||
    entry.ownerAuthProvenance !== 'unknown' ||
    !entry.messageId ||
    entry.mergedMessageIds.length !== 0 ||
    entry.targetCats.length !== 1 ||
    entry.allTargetCats?.length !== 1 ||
    entry.allTargetCats[0] !== entry.targetCats[0] ||
    entry.intent !== 'execute' ||
    !entry.autoExecute ||
    entry.queueCustodyAdmissionId !== undefined ||
    entry.authorIntentByCatId !== undefined ||
    entry.exactSteerBatch !== undefined ||
    entry.prestartRetirement !== undefined ||
    entry.callerCatId !== undefined ||
    entry.a2aParentInvocationId !== undefined ||
    entry.cloudDispatchProvenance !== undefined ||
    entry.requiresExactCloudDispatchProvenance !== undefined ||
    entry.senderMeta !== undefined ||
    entry.continuationKey !== undefined ||
    entry.freshnessClosureId !== undefined ||
    entry.freshnessSupplementId !== undefined ||
    entry.readOnlyToolPolicy !== undefined ||
    entry.actionSuccessorFence !== undefined ||
    entry.waitContinuationCarrier !== undefined ||
    entry.suggestedSkill !== undefined ||
    entry.callerTraceContext !== undefined ||
    entry.a2aTriggerMessageId !== undefined
  )
    throw new Error('Host Task Queue entry rejected');
}
