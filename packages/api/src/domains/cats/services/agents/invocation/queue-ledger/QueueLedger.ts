import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CatRoutingError,
  MessageFrom,
  QueueAuthorIntent,
  QueueReminderAttempt,
  WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import { isMessageFrom } from '@cat-cafe/shared';
import type { CallerTraceContext } from '../../../../../../infrastructure/telemetry/genai-semconv.js';
import type { ActionSuccessorFence } from '../../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type { CloudDispatchProvenance } from '../../../cloud-bridge/types.js';
import type { ToolExecutionPolicy } from '../../../types.js';
import type { OwnerAuthProvenance } from '../owner-auth-provenance.js';

export type QueueOwner = { kind: 'user'; userId: string } | { kind: 'system'; service: string };

/** `processing`/`terminal` are transient transition snapshots; durable rows are only queued or short-claimed. */
export type QueueLedgerStatus = 'queued' | 'claimed' | 'processing' | 'terminal';

export interface QueuePrestartRetirementIntent {
  id: string;
  primaryEntryId: string;
  entryIds: string[];
  targetCatId: string;
  startedAt: number;
}

export interface QueueLedgerPayload {
  /** Stable identity of the one source record represented by this Queue Entry. */
  sourceRecordId: string;
  content: string;
  messageId?: string;
  routingWarnings?: readonly CatRoutingError[];
}

export interface QueueLedgerExecution {
  intent: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  autoExecute: boolean;
  a2aParentInvocationId?: string;
  freshnessClosureId?: string;
  freshnessSupplementId?: string;
  freshnessSupplementLineageId?: string;
  freshnessSupplementSeq?: 1 | 2;
  readOnlyToolPolicy?: ToolExecutionPolicy;
  actionSuccessorFence?: ActionSuccessorFence;
  waitContinuationCarrier?: WaitContinuationCarrierV1;
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  a2aTriggerMessageId?: string;
  cloudDispatchProvenance?: CloudDispatchProvenance;
  requiresExactCloudDispatchProvenance?: boolean;
}

export interface QueueLedgerDelivery {
  authorIntentByTarget?: Record<string, QueueAuthorIntent>;
  steerRequestedAt?: number;
  reminderAttempts?: readonly QueueReminderAttempt[];
}

/**
 * RFC #1356 canonical Queue record. One source has one durable Queue Entry;
 * targets are the exact members whose delivery is still pending. History owns
 * actual delivery receipts, so a target must leave this set when it is adopted.
 */
export interface QueueLedgerEntry {
  version: 2;
  id: string;
  threadId: string;
  owner: QueueOwner;
  kind: 'conversation_input' | 'message_wake' | 'private_input';
  from: MessageFrom;
  targets: string[];
  payload: QueueLedgerPayload;
  execution: QueueLedgerExecution;
  delivery: QueueLedgerDelivery;
  status: QueueLedgerStatus;
  enqueuedAt: number;
  claimedAt?: number;
  claimId?: string;
  /** Exact pending targets protected by the short reversible claim. */
  claimedTargetIds?: string[];
  /** The claimed target was resolved from a previously targetless entry. */
  claimedFromTargetless?: boolean;
  processingStartedAt?: number;
  terminalAt?: number;
  retiringGroupId?: string;
  priority: 'urgent' | 'normal';
  sourceCategory?:
    | 'ci'
    | 'review'
    | 'conflict'
    | 'scheduled'
    | 'a2a'
    | 'a2a_failure'
    | 'continuation'
    | 'issue'
    | 'freshness';
  position?: number;
}

export interface QueueLedgerEnqueueResult {
  outcome: 'enqueued' | 'replayed' | 'full' | 'conflict';
  entries: QueueLedgerEntry[];
}

export type QueueLedgerTargetExpansionResult =
  | { outcome: 'expanded' | 'replayed'; entries: QueueLedgerEntry[] }
  | { outcome: 'not_found' | 'state_changed' | 'conflict'; entries: [] };

export type QueueLedgerTargetReconcileResult =
  | { outcome: 'updated' | 'replayed'; entry: QueueLedgerEntry | null }
  | { outcome: 'not_found' | 'state_changed' };

export type QueueLedgerClaimResult =
  | { outcome: 'claimed'; entries: QueueLedgerEntry[]; claimId: string }
  | { outcome: 'not_found' | 'state_changed' };

export type QueueLedgerTransitionResult =
  | { outcome: 'updated'; entry: QueueLedgerEntry }
  | { outcome: 'not_found' | 'state_changed' };

export type QueueLedgerCommitMode = 'queued' | 'processing' | 'processing_evidence' | 'terminal' | 'withdrawn';

export interface QueueLedgerStore {
  enqueue(entries: readonly QueueLedgerEntry[], maxQueuedUserEntries?: number): Promise<QueueLedgerEnqueueResult>;
  /** Atomically bind an optional targetless entry and merge additional targets into that same source entry. */
  expandTargets(
    threadId: string,
    entryId: string,
    bindTargetCatId: string,
    expectedQueuedEntryIds: readonly string[],
    siblingEntries: readonly QueueLedgerEntry[],
  ): Promise<QueueLedgerTargetExpansionResult>;
  /** Atomically apply an explicit Steer target delta to one pending source record. */
  reconcileTargets(
    threadId: string,
    entryId: string,
    addTargetIds: readonly string[],
    removeTargetIds: readonly string[],
    authorIntentByTarget: Readonly<Record<string, QueueAuthorIntent>>,
  ): Promise<QueueLedgerTargetReconcileResult>;
  listThreadIds(): Promise<string[]>;
  list(threadId: string): Promise<QueueLedgerEntry[]>;
  /** Active Queue rows only. History owns delivery and terminal truth. */
  listAll(threadId: string): Promise<QueueLedgerEntry[]>;
  /** Active Queue rows for exact Message identities, without scanning thread history. */
  getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>>;
  get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null>;
  claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult>;
  claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult>;
  commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
    replacement?: QueueLedgerEntry,
  ): Promise<QueueLedgerTransitionResult>;
  restore(
    threadId: string,
    entryId: string,
    claimId: string,
    restoreUnassignedTarget?: boolean,
  ): Promise<QueueLedgerTransitionResult>;
}

export function queueOwnerKey(owner: QueueOwner): string {
  return owner.kind === 'user' ? `user:${owner.userId}` : `system:${owner.service}`;
}

export function queueOwner(entry: { owner?: QueueOwner; userId?: string }): QueueOwner {
  if (entry.owner) return structuredClone(entry.owner);
  if (!entry.userId) throw new Error('queue owner is missing');
  if (entry.userId === 'system' || entry.userId === 'scheduler') {
    return { kind: 'system', service: entry.userId };
  }
  return { kind: 'user', userId: entry.userId };
}

export function queueEntryId(sourcePersistentId: string, _targetCatId?: string): string {
  if (!sourcePersistentId) throw new Error('queue entry identity requires a persistent source');
  const digest = createHash('sha256').update(sourcePersistentId).digest('hex').slice(0, 32);
  return `queue:${digest}`;
}

export function cloneQueueLedgerEntry(entry: QueueLedgerEntry): QueueLedgerEntry {
  return structuredClone(entry);
}

/**
 * Compare only the immutable producer admission contract. Lifecycle progress,
 * queue ordering, and distributed trace context may legitimately differ when
 * the same durable source is replayed.
 */
export function queueLedgerAdmissionsMatch(existing: QueueLedgerEntry, incoming: QueueLedgerEntry): boolean {
  const { callerTraceContext: _existingTrace, ...existingExecution } = existing.execution;
  const { callerTraceContext: _incomingTrace, ...incomingExecution } = incoming.execution;
  return (
    existing.version === incoming.version &&
    existing.id === incoming.id &&
    existing.threadId === incoming.threadId &&
    isDeepStrictEqual(existing.owner, incoming.owner) &&
    existing.kind === incoming.kind &&
    isDeepStrictEqual(existing.from, incoming.from) &&
    isDeepStrictEqual(existing.targets, incoming.targets) &&
    isDeepStrictEqual(existing.payload, incoming.payload) &&
    isDeepStrictEqual(existingExecution, incomingExecution) &&
    isDeepStrictEqual(existing.delivery.authorIntentByTarget, incoming.delivery.authorIntentByTarget) &&
    existing.priority === incoming.priority &&
    existing.sourceCategory === incoming.sourceCategory
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== undefined && !isFiniteTimestamp(value)) throw new Error(`queue ledger ${field} is invalid`);
}

function assertQueueLedgerState(entry: QueueLedgerEntry): void {
  if (
    entry.status === 'queued' &&
    (entry.claimId !== undefined ||
      entry.claimedAt !== undefined ||
      entry.claimedTargetIds !== undefined ||
      entry.claimedFromTargetless !== undefined)
  ) {
    throw new Error('queued ledger entry cannot carry a claim');
  }
  if (
    entry.status === 'claimed' &&
    (!entry.claimId ||
      entry.claimedAt === undefined ||
      !Array.isArray(entry.claimedTargetIds) ||
      entry.claimedTargetIds.some((targetId) => !entry.targets.includes(targetId)))
  ) {
    throw new Error('claimed ledger entry requires claim identity and timestamp');
  }
  if (entry.status === 'processing' && entry.processingStartedAt === undefined) {
    throw new Error('processing ledger entry requires processingStartedAt');
  }
  if (entry.status === 'terminal' && entry.terminalAt === undefined) {
    throw new Error('terminal ledger entry requires terminalAt');
  }
  if (entry.status === 'terminal' && (entry.claimId !== undefined || entry.claimedAt !== undefined)) {
    throw new Error('terminal ledger entry cannot carry a claim');
  }
}

function assertQueueOwner(value: unknown): asserts value is QueueOwner {
  if (!isRecord(value)) throw new Error('queue ledger owner is invalid');
  const owner = value as Partial<QueueOwner>;
  if (owner.kind === 'user' && typeof owner.userId === 'string' && owner.userId) return;
  if (owner.kind === 'system' && typeof owner.service === 'string' && owner.service) return;
  throw new Error('queue ledger owner is incomplete');
}

function assertQueueTargets(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    !value.every((targetId) => typeof targetId === 'string' && targetId.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('queue ledger targets are invalid');
  }
}

function assertQueuePayload(value: unknown): asserts value is QueueLedgerPayload {
  if (!isRecord(value) || typeof value.sourceRecordId !== 'string' || !value.sourceRecordId) {
    throw new Error('queue ledger payload identity is incomplete');
  }
  if (typeof value.content !== 'string') throw new Error('queue ledger payload content is invalid');
  if (value.messageId !== undefined && typeof value.messageId !== 'string') {
    throw new Error('queue ledger payload messageId is invalid');
  }
}

function assertQueueExecution(value: unknown): asserts value is QueueLedgerExecution {
  if (!isRecord(value)) throw new Error('queue ledger execution is invalid');
  if (typeof value.intent !== 'string' || !value.intent) throw new Error('queue ledger execution intent is invalid');
  if (!['strict', 'compatibility_fallback', 'unknown'].includes(String(value.ownerAuthProvenance))) {
    throw new Error('queue ledger owner auth provenance is invalid');
  }
  if (typeof value.autoExecute !== 'boolean') throw new Error('queue ledger autoExecute is invalid');
  if (
    value.requiresExactCloudDispatchProvenance !== undefined &&
    typeof value.requiresExactCloudDispatchProvenance !== 'boolean'
  ) {
    throw new Error('queue ledger exact cloud provenance requirement is invalid');
  }
  if (value.cloudDispatchProvenance !== undefined) {
    if (
      !isRecord(value.cloudDispatchProvenance) ||
      typeof value.cloudDispatchProvenance.sourceMessageId !== 'string' ||
      !value.cloudDispatchProvenance.sourceMessageId ||
      typeof value.cloudDispatchProvenance.calledByCatId !== 'string' ||
      !value.cloudDispatchProvenance.calledByCatId ||
      typeof value.cloudDispatchProvenance.intent !== 'string' ||
      !isRecord(value.cloudDispatchProvenance.sourceSender)
    ) {
      throw new Error('queue ledger cloud dispatch provenance is invalid');
    }
  }
}

function assertQueueClassification(entry: Partial<QueueLedgerEntry>): void {
  if (entry.kind !== 'conversation_input' && entry.kind !== 'message_wake' && entry.kind !== 'private_input') {
    throw new Error('queue ledger kind is invalid');
  }
  if (!['queued', 'claimed', 'processing', 'terminal'].includes(entry.status ?? '')) {
    throw new Error('queue ledger status is invalid');
  }
  if (entry.priority !== 'urgent' && entry.priority !== 'normal') throw new Error('queue ledger priority is invalid');
  const sourceCategories = [
    'ci',
    'review',
    'conflict',
    'scheduled',
    'a2a',
    'a2a_failure',
    'continuation',
    'issue',
    'freshness',
  ];
  if (entry.sourceCategory !== undefined && !sourceCategories.includes(entry.sourceCategory)) {
    throw new Error('queue ledger source category is invalid');
  }
}

export function assertQueueLedgerEntry(value: unknown): asserts value is QueueLedgerEntry {
  if (!isRecord(value)) throw new Error('queue ledger row is invalid');
  const entry = value as Partial<QueueLedgerEntry>;
  if (entry.version !== 2) throw new Error('unsupported queue ledger entry version');
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.threadId !== 'string' || !entry.threadId) {
    throw new Error('queue ledger identity is incomplete');
  }
  assertQueueOwner(entry.owner);
  assertQueueClassification(entry);
  assertQueueTargets(entry.targets);
  if (!isMessageFrom(entry.from)) throw new Error('queue ledger sender is invalid');
  assertQueuePayload(entry.payload);
  assertQueueExecution(entry.execution);
  if (!isRecord(entry.delivery)) throw new Error('queue ledger delivery is invalid');
  if (!isFiniteTimestamp(entry.enqueuedAt)) throw new Error('queue ledger enqueuedAt is invalid');
  assertOptionalTimestamp(entry.claimedAt, 'claimedAt');
  assertOptionalTimestamp(entry.processingStartedAt, 'processingStartedAt');
  assertOptionalTimestamp(entry.terminalAt, 'terminalAt');
  assertQueueLedgerState(entry as QueueLedgerEntry);
}
