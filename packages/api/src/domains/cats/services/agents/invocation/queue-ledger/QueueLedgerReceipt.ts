import type { QueueMessageReceipt, QueueReceiptTarget, QueueTargetAttempt } from '@cat-cafe/shared';
import type { QueueLedgerEntry } from './QueueLedger.js';

function targetState(entry: QueueLedgerEntry): QueueReceiptTarget['state'] {
  if (entry.status === 'terminal') return entry.delivery.terminalOutcome ?? 'interrupted';
  if (entry.delivery.steerRequestedAt !== undefined) return 'steering';
  if (entry.delivery.failedAt !== undefined) return 'failed';
  if (entry.delivery.seenAt !== undefined) return 'seen';
  if (entry.delivery.awakenedInvocationId) return 'awakened';
  if (entry.delivery.notifiedAt !== undefined) return 'notified';
  return 'queued';
}

function attemptState(state: QueueReceiptTarget['state']): QueueTargetAttempt['state'] {
  if (state === 'handled') return 'handled';
  if (state === 'failed') return 'failed';
  if (state === 'interrupted') return 'interrupted';
  if (state === 'cancelled' || state === 'withdrawn') return 'cancelled';
  return state === 'queued' || state === 'notified' ? 'queued' : 'starting';
}

function projectAuthorIntent(entry: QueueLedgerEntry): QueueReceiptTarget['authorIntent'] {
  const intent = entry.delivery.authorIntent;
  if (!intent) return undefined;
  return {
    ...intent,
    effective: intent.fallbackAt ? 'next_work' : intent.requested,
  };
}

function projectTarget(entry: QueueLedgerEntry): QueueReceiptTarget | null {
  if (entry.target.kind !== 'cat') return null;
  const state = targetState(entry);
  const invocationId = entry.delivery.seenInvocationId ?? entry.delivery.awakenedInvocationId;
  const exposure = [...(entry.delivery.bodyExposures ?? [])]
    .reverse()
    .find((candidate) => !invocationId || candidate.invocationId === invocationId);
  const updatedAt =
    entry.terminalAt ??
    entry.delivery.failedAt ??
    entry.delivery.handledAt ??
    entry.delivery.seenAt ??
    entry.delivery.awakenedAt ??
    entry.delivery.notifiedAt ??
    entry.enqueuedAt;
  const attempt: QueueTargetAttempt = {
    id: entry.delivery.attemptId ?? `${entry.id}:1`,
    targetCatId: entry.target.catId,
    sequence: 1,
    state: attemptState(state),
    createdAt: entry.enqueuedAt,
    updatedAt,
    ...(invocationId ? { invocationId } : {}),
    ...(exposure ? { seenAt: exposure.seenAt } : {}),
    ...(entry.delivery.failureReason ? { terminalReason: entry.delivery.failureReason } : {}),
  };
  const authorIntent = projectAuthorIntent(entry);
  return {
    catId: entry.target.catId,
    state,
    ...(authorIntent ? { authorIntent } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(entry.delivery.awakenedAt !== undefined ? { awakenedAt: entry.delivery.awakenedAt } : {}),
    ...(exposure ? { seenAt: exposure.seenAt } : {}),
    ...(state === 'withdrawn' && entry.terminalAt !== undefined ? { withdrawnAt: entry.terminalAt } : {}),
    attempts: [attempt],
    retryable: false,
  };
}

/** Project one message's scalar durable rows into the browser receipt DTO. */
export function projectQueueLedgerReceipt(entries: readonly QueueLedgerEntry[]): QueueMessageReceipt | undefined {
  const targets = entries
    .map(projectTarget)
    .filter((target): target is QueueReceiptTarget => target !== null)
    .sort((left, right) => left.catId.localeCompare(right.catId));
  if (targets.length === 0) return undefined;
  return {
    version: 1,
    entryId: entries[0]?.payload.sourceId ?? entries[0]?.id ?? '',
    targets,
    reminderAttempts: entries.flatMap((entry) => entry.delivery.reminderAttempts ?? []),
  };
}
