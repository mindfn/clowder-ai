import { isDeepStrictEqual } from 'node:util';
import type { QueueTargetAttempt } from '@cat-cafe/shared';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import {
  assertPublicInvocationQueueBinding,
  type PluginPublicInvocationCarrierV1,
} from '../../stores/ports/plugin-public-invocation-carrier.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueueCustodyTransition,
  cloneQueuedMessageCustody,
} from '../../stores/ports/queued-message-custody.js';
import type { QueueEntry } from './InvocationQueue.js';

export interface PublicInvocationChildInput {
  readonly entry: QueueEntry;
  readonly invocationId: string;
}
export type PublicInvocationChildResult =
  | { readonly kind: 'bound'; readonly custody: QueuedMessageCustody }
  | { readonly kind: 'conflict' };

interface Coordinates {
  readonly entryId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly invocationId: string;
  readonly content: string;
  readonly carrier: PluginPublicInvocationCarrierV1;
}
function validCoordinate(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}
function capture(input: PublicInvocationChildInput): Coordinates {
  const { entry, invocationId } = input;
  assertPublicInvocationQueueBinding(entry);
  if (
    !entry.pluginPublicInvocation ||
    entry.status !== 'queued' ||
    ![entry.id, entry.userId, entry.threadId, invocationId].every(validCoordinate) ||
    typeof entry.content !== 'string'
  )
    throw new Error('Invalid public child custody input');
  return snapshotPluginProtocolData({
    entryId: entry.id,
    userId: entry.userId,
    threadId: entry.threadId,
    invocationId,
    content: entry.content,
    carrier: entry.pluginPublicInvocation,
  }) as Coordinates;
}

function matchingSource(message: StoredMessage | null, expected: Coordinates): boolean {
  const { carrier } = expected;
  return Boolean(
    message &&
      message.id === carrier.sourceMessageId &&
      message.userId === expected.userId &&
      message.threadId === expected.threadId &&
      message.catId === null &&
      message.content === expected.content &&
      message.deliveryStatus === 'queued' &&
      !message.deletedAt &&
      !message.recall &&
      !message._tombstone &&
      !message.sourceParseFailure &&
      message.source?.connector &&
      message.extra?.pluginMessage?.instanceId === carrier.pluginInstanceId &&
      message.extra.pluginMessage.revision === carrier.sourcePluginRevision,
  );
}
function matchingCustody(message: StoredMessage | null, expected: Coordinates): QueuedMessageCustody | undefined {
  if (!matchingSource(message, expected) || !message?.queueCustody) return undefined;
  try {
    assertQueueCustodyMessageBinding(message);
  } catch {
    return undefined;
  }
  const current = message.queueCustody;
  if (
    current.entryId !== expected.entryId ||
    current.ownerUserId !== expected.userId ||
    current.ownerAuthProvenance !== 'unknown' ||
    !isDeepStrictEqual(current.pluginPublicInvocation, expected.carrier)
  )
    return undefined;
  return current;
}
function unbound(current: QueuedMessageCustody, target: string): boolean {
  const histories = [
    current.failedByCatIds,
    current.handledByCatIds,
    current.withdrawnByCatIds,
    current.steerRequestedByCatIds,
    current.seenByCatIds,
  ];
  const witnesses = [
    current.awakenedInvocationIdByCatId,
    current.awakenedAtByCatId,
    current.seenInvocationIdByCatId,
    current.steeredInvocationIdByCatId,
    current.targetOutcomeByCatId,
  ];
  return (
    current.status === 'queued' &&
    current.pendingTargetCats.some((cat) => cat === target) &&
    !current.prestartRetirement &&
    current.processingStartedAt === undefined &&
    histories.every((values) => !values?.some((cat) => cat === target)) &&
    witnesses.every((values) => values?.[target] === undefined) &&
    !current.bodyExposures?.length &&
    !current.readEvidenceWitnesses?.length &&
    (current.targetAttempts ?? []).length <= 1 &&
    (current.targetAttempts ?? []).every(
      (attempt) =>
        attempt.state === 'queued' &&
        attempt.sequence === 1 &&
        attempt.invocationId === undefined &&
        attempt.seenAt === undefined &&
        attempt.terminalReason === undefined,
    )
  );
}
function nextCustody(current: QueuedMessageCustody, expected: Coordinates, timestamp: number): QueuedMessageCustody {
  const target = expected.carrier.targetCatId;
  const time = Math.max(timestamp, current.updatedAt);
  const initial: QueueTargetAttempt = current.targetAttempts?.[0] ?? {
    id: `${current.entryId}:${target}:1`,
    targetCatId: target,
    sequence: 1,
    state: 'queued',
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
  const next = cloneQueuedMessageCustody(current);
  next.revision++;
  next.status = 'processing';
  next.processingStartedAt = time;
  next.updatedAt = time;
  next.awakenedInvocationIdByCatId = { [target]: expected.invocationId };
  next.awakenedAtByCatId = { [target]: time };
  next.targetAttempts = [
    {
      ...initial,
      state: 'starting',
      invocationId: expected.invocationId,
      updatedAt: Math.max(time, initial.updatedAt),
    },
  ];
  assertQueueCustodyTransition(current, { expectedRevision: current.revision, next });
  return next;
}

/**
 * Mechanical single-source CAS, not business admission. The caller must preflight authority and
 * recheck exact-child currentness before resuming its generator. Every non-bound result or exception
 * requires retiring the candidate child; even a conflict may follow an applied CAS and stale readback.
 */
export async function bindPublicInvocationChild(
  store: Pick<IMessageStore, 'getById' | 'transitionQueueCustody'>,
  input: PublicInvocationChildInput,
  now: () => number,
): Promise<PublicInvocationChildResult> {
  const expected = capture(input);
  const message = await store.getById(expected.carrier.sourceMessageId);
  if (!message) return { kind: 'conflict' };
  const current = matchingCustody(message, expected);
  if (!current || !unbound(current, expected.carrier.targetCatId)) return { kind: 'conflict' };
  // Pin source provenance before the CAS awaits. No prompt-body exposure is recorded here.
  const source = snapshotPluginProtocolData(message.source);
  const timestamp = now();
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid public child custody timestamp');
  const next = nextCustody(current, expected, timestamp);
  const result = await store.transitionQueueCustody(expected.carrier.sourceMessageId, {
    expectedRevision: current.revision,
    next,
  });
  if (result.kind !== 'updated') return { kind: 'conflict' };
  const canonical = matchingCustody(result.message, expected);
  if (!canonical || !isDeepStrictEqual(canonical, next) || !isDeepStrictEqual(result.message.source, source))
    return { kind: 'conflict' };
  return { kind: 'bound', custody: cloneQueuedMessageCustody(canonical) };
}
