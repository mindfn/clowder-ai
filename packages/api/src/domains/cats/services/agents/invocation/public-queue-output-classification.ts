import { isDeepStrictEqual } from 'node:util';
import type { CatId, QueueSourceResponseConsumptionWitness } from '@cat-cafe/shared';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import { compareCursors, cursorFor, parseCursor } from '../../stores/cursor.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { assertQueuedMessageCustody } from '../../stores/ports/queued-message-custody.js';
import {
  assertCreateTurnExecutionInput,
  assertTurnExecutionTerminalInput,
  type TurnExecutionRecord,
} from '../../stores/ports/TurnExecutionStore.js';
import { committedPublicInvocationOutput, parsePublicInvocationOutput } from '../../stores/public-invocation-output.js';
import type { PublicOutputRecoveryRead } from '../../stores/public-invocation-output-recovery.js';
import { canViewMessage } from '../../stores/visibility.js';

export interface PublicQueueClassificationInput {
  readonly sourceMessageId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: CatId;
}
export type PublicQueueClassification = {
  kind: 'not_public' | 'unbound' | 'deferred' | 'committed' | 'abandoned' | 'conflict';
  reason: string;
  /** Observed source, never a settlement grant: the consumer must fence its own custody CAS. */
  source?: StoredMessage;
  childInvocationId?: string;
  outputMessageId?: string;
  witness?: QueueSourceResponseConsumptionWitness;
};
export interface PublicQueueSource {
  source: StoredMessage;
  childInvocationId?: string;
}

export function capturePublicQueueSelection(input: PublicQueueClassificationInput): PublicQueueClassificationInput {
  const value = snapshotPluginProtocolData(input) as PublicQueueClassificationInput;
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    !['sourceMessageId', 'userId', 'threadId', 'catId'].every((key) => {
      const coordinate = value[key as keyof PublicQueueClassificationInput];
      return typeof coordinate === 'string' && coordinate.length > 0 && coordinate.trim() === coordinate;
    })
  )
    throw new Error('Invalid Queue selection');
  return value;
}

export function capturePublicQueueSource(
  raw: StoredMessage | null,
  selection: PublicQueueClassificationInput,
): PublicQueueSource | PublicQueueClassification {
  if (!raw) return { kind: 'conflict', reason: 'missing_source' };
  const source = snapshotPluginProtocolData(raw) as StoredMessage;
  if (
    source.id !== selection.sourceMessageId ||
    source.threadId !== selection.threadId ||
    source.userId !== selection.userId
  )
    return { kind: 'conflict', reason: 'source_identity_mismatch' };
  const custody = source.queueCustody;
  if (!custody || !Object.hasOwn(custody, 'pluginPublicInvocation'))
    return { kind: 'not_public', reason: 'ordinary_source' };
  assertQueuedMessageCustody(custody);
  const carrier = custody.pluginPublicInvocation;
  if (
    !carrier ||
    carrier.sourceMessageId !== source.id ||
    carrier.targetCatId !== selection.catId ||
    custody.ownerUserId !== selection.userId ||
    custody.ownerAuthProvenance !== 'unknown' ||
    source.catId !== null ||
    !source.source?.connector ||
    source.sourceParseFailure ||
    source.extra?.pluginMessage?.instanceId !== carrier.pluginInstanceId ||
    source.extra.pluginMessage.revision !== carrier.sourcePluginRevision
  )
    return { kind: 'conflict', reason: 'source_identity_mismatch' };
  const ids = new Set<string>();
  const add = (id: string | undefined) => {
    if (id !== undefined) {
      if (!id.trim()) throw new Error('Empty child witness');
      ids.add(id);
    }
  };
  add(custody.seenInvocationIdByCatId[selection.catId]);
  add(custody.awakenedInvocationIdByCatId?.[selection.catId]);
  for (const exposure of custody.bodyExposures ?? [])
    if (exposure.targetCatId === selection.catId) add(exposure.invocationId);
  for (const attempt of custody.targetAttempts ?? [])
    if (attempt.targetCatId === selection.catId) add(attempt.invocationId);
  if (ids.size > 1) return { kind: 'conflict', reason: 'conflicting_child_witnesses', source };
  const childInvocationId = [...ids][0];
  return { source, ...(childInvocationId ? { childInvocationId } : {}) };
}

export function exactPublicQueueChild(
  child: TurnExecutionRecord,
  source: StoredMessage,
  selection: PublicQueueClassificationInput,
  id: string,
): boolean {
  assertCreateTurnExecutionInput(child);
  if (child.status !== 'running')
    assertTurnExecutionTerminalInput(child, {
      status: child.status,
      endedAt: child.endedAt ?? Number.NaN,
      ...(child.terminalReason !== undefined ? { terminalReason: child.terminalReason } : {}),
    });
  else if (child.endedAt !== undefined || child.terminalReason !== undefined) return false;
  return (
    child.invocationId === id &&
    child.userId === selection.userId &&
    child.threadId === selection.threadId &&
    child.catId === selection.catId &&
    child.executionKind === 'ordinary' &&
    child.queueCompletionPolicy === 'explicit_source' &&
    child.causal?.triggerMessageId === source.id &&
    isDeepStrictEqual(child.causal?.coveredMessageIds, [source.id]) &&
    child.causal?.freshnessSupplementId === undefined &&
    child.causal?.routingGuardReason === undefined
  );
}

function sourceCurrent(source: StoredMessage, catId: CatId): boolean {
  const custody = source.queueCustody;
  return Boolean(
    custody &&
      !source.deletedAt &&
      !source._tombstone &&
      !source.recall &&
      source.deliveryStatus === 'queued' &&
      custody.status !== 'terminal' &&
      custody.pendingTargetCats.includes(catId) &&
      !custody.withdrawnByCatIds?.includes(catId) &&
      !custody.failedByCatIds.includes(catId) &&
      !custody.handledByCatIds.includes(catId) &&
      !custody.prestartRetirement &&
      !custody.steerRequestedByCatIds?.includes(catId) &&
      !custody.steeredInvocationIdByCatId?.[catId] &&
      canViewMessage(source, { type: 'cat', catId }),
  );
}
function exactExposure(source: StoredMessage, child: TurnExecutionRecord): boolean {
  return Boolean(
    source.queueCustody?.bodyExposures?.some(
      (item) =>
        item.targetCatId === child.catId &&
        item.invocationId === child.invocationId &&
        item.seenAt >= child.startedAt &&
        child.endedAt !== undefined &&
        item.seenAt <= child.endedAt,
    ),
  );
}
function exactVisibleBoundary(
  output: StoredMessage,
  source: StoredMessage,
  child: TurnExecutionRecord,
  boundary: StoredMessage | null,
): boolean {
  const receipt = committedPublicInvocationOutput(output);
  if (!receipt || !exactExposure(source, child) || !sourceCurrent(source, child.catId)) return false;
  const cursor = receipt.boundary.cursor;
  const boundaryId = parseCursor(cursor)?.id;
  return (
    !!boundary &&
    boundary.id === boundaryId &&
    boundary.threadId === source.threadId &&
    boundary.userId === source.userId &&
    boundary.visibilitySeq !== undefined &&
    output.visibilitySeq !== undefined &&
    !boundary.deletedAt &&
    !boundary._tombstone &&
    !boundary.recall &&
    boundary.deliveryStatus !== 'canceled' &&
    canViewMessage(boundary, { type: 'cat', catId: child.catId }) &&
    canViewMessage(output, { type: 'cat', catId: child.catId }) &&
    cursorFor(boundary) === cursor &&
    compareCursors(cursor, cursorFor(output)) < 0 &&
    (output.content.trim().length > 0 || (output.contentBlocks?.length ?? 0) > 0)
  );
}

/** Output state comes only from the strict store recovery reader, never forgiving history hydration. */
export function decidePublicQueueOutput(
  source: StoredMessage,
  child: TurnExecutionRecord,
  observed: PublicOutputRecoveryRead,
  boundary: StoredMessage | null,
): PublicQueueClassification {
  if (observed.kind === 'missing') return { kind: 'conflict', reason: 'output_disappeared' };
  if (observed.kind === 'malformed' || observed.kind === 'quarantined')
    return { kind: 'conflict', reason: observed.kind };
  const message =
    observed.kind === 'pending' ? { ...observed.expected, id: observed.expected.reservedId } : observed.message;
  const receipt = parsePublicInvocationOutput(message.extra?.publicOutputV1);
  if (
    !receipt ||
    receipt.sourceMessageId !== source.id ||
    receipt.childInvocationId !== child.invocationId ||
    receipt.outputMessageId !== message.id ||
    message.userId !== child.userId ||
    message.threadId !== child.threadId ||
    message.catId !== child.catId ||
    message.extra?.stream?.invocationId !== child.parentInvocationId ||
    message.extra?.stream?.turnInvocationId !== child.invocationId
  )
    return { kind: 'conflict', reason: 'output_identity_mismatch' };
  if (observed.kind === 'pending')
    return { kind: 'deferred', reason: 'pending_output', outputMessageId: receipt.outputMessageId };
  if (receipt.state === 'abandoned' && ['failed', 'canceled', 'interrupted'].includes(child.status))
    return { kind: 'abandoned', reason: 'public_output_abandoned', outputMessageId: receipt.outputMessageId };
  if (receipt.state !== 'committed' || child.status !== 'succeeded')
    return { kind: 'conflict', reason: 'terminal_projection_mismatch' };
  if (!exactVisibleBoundary(observed.message, source, child, boundary))
    return { kind: 'conflict', reason: 'consumption_proof_mismatch' };
  return {
    kind: 'committed',
    reason: 'source_response',
    outputMessageId: receipt.outputMessageId,
    witness: { kind: 'source_response', outputMessageIds: [receipt.outputMessageId] },
  };
}

export type PublicQueueMessageReader = Pick<
  IMessageStore,
  'getById' | 'findPublicInvocationOutput' | 'readPublicInvocationOutputRecovery'
>;
