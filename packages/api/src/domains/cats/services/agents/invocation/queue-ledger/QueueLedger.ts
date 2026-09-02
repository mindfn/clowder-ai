import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CatRoutingError,
  MessageFrom,
  QueueAuthorIntent,
  QueueTargetAttemptTerminalReason,
  WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import { isMessageFrom } from '@cat-cafe/shared';
import type { CallerTraceContext } from '../../../../../../infrastructure/telemetry/genai-semconv.js';
import type { ActionSuccessorFence } from '../../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type { QueueBodyExposure } from '../../../stores/ports/queued-message-custody.js';
import type { ToolExecutionPolicy } from '../../../types.js';
import type { OwnerAuthProvenance } from '../owner-auth-provenance.js';

export type QueueOwner = { kind: 'user'; userId: string } | { kind: 'system'; service: string };

export type QueueLedgerStatus = 'queued' | 'claimed' | 'processing' | 'terminal';
export type QueueLedgerTarget = { kind: 'cat'; catId: string } | { kind: 'unassigned' };

export interface QueueLedgerPayload {
  /** Persistent producer identity shared by every row in one fan-out group. */
  sourceId: string;
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
}

export interface QueueLedgerDelivery {
  authorIntent?: QueueAuthorIntent;
  notifiedAt?: number;
  awakenedInvocationId?: string;
  awakenedAt?: number;
  seenAt?: number;
  seenInvocationId?: string;
  bodyExposures?: readonly QueueBodyExposure[];
  failedAt?: number;
  failureReason?: QueueTargetAttemptTerminalReason;
  attemptId?: string;
  handledAt?: number;
  steerRequestedAt?: number;
  steeredInvocationId?: string;
}

/**
 * ADR-043 canonical row. Variable execution and receipt data is nested so the
 * queue lifecycle itself stays small and cannot grow another per-cat mirror.
 */
export interface QueueLedgerEntry {
  version: 1;
  id: string;
  threadId: string;
  owner: QueueOwner;
  kind: 'conversation_input' | 'message_wake' | 'private_input';
  from: MessageFrom;
  target: QueueLedgerTarget;
  payload: QueueLedgerPayload;
  execution: QueueLedgerExecution;
  delivery: QueueLedgerDelivery;
  status: QueueLedgerStatus;
  enqueuedAt: number;
  claimedAt?: number;
  claimId?: string;
  processingStartedAt?: number;
  terminalAt?: number;
  retiringGroupId?: string;
  priority: 'urgent' | 'normal';
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'continuation' | 'issue' | 'freshness';
  position?: number;
}

export interface QueueLedgerEnqueueResult {
  outcome: 'enqueued' | 'replayed' | 'full' | 'conflict';
  entries: QueueLedgerEntry[];
}

export type QueueLedgerClaimResult =
  | { outcome: 'claimed'; entries: QueueLedgerEntry[]; claimId: string }
  | { outcome: 'not_found' | 'state_changed' };

export type QueueLedgerTransitionResult =
  | { outcome: 'updated'; entry: QueueLedgerEntry }
  | { outcome: 'not_found' | 'state_changed' };

export type QueueLedgerCommitMode = 'queued' | 'processing' | 'terminal' | 'withdrawn';

export interface QueueLedgerStore {
  enqueue(entries: readonly QueueLedgerEntry[], maxQueuedUserEntries?: number): Promise<QueueLedgerEnqueueResult>;
  listThreadIds(): Promise<string[]>;
  list(threadId: string): Promise<QueueLedgerEntry[]>;
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
  restore(threadId: string, entryId: string, claimId: string): Promise<QueueLedgerTransitionResult>;
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

export function queueEntryId(sourcePersistentId: string, targetCatId?: string): string {
  if (!sourcePersistentId) throw new Error('queue entry identity requires a persistent source');
  const targetIdentity = targetCatId || 'unassigned';
  const digest = createHash('sha256').update(`${sourcePersistentId}\0${targetIdentity}`).digest('hex').slice(0, 32);
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
  const targetMatches =
    isDeepStrictEqual(existing.target, incoming.target) ||
    (incoming.target.kind === 'unassigned' && incoming.id === queueEntryId(incoming.payload.sourceId));
  return (
    existing.version === incoming.version &&
    existing.id === incoming.id &&
    existing.threadId === incoming.threadId &&
    isDeepStrictEqual(existing.owner, incoming.owner) &&
    existing.kind === incoming.kind &&
    isDeepStrictEqual(existing.from, incoming.from) &&
    targetMatches &&
    isDeepStrictEqual(existing.payload, incoming.payload) &&
    isDeepStrictEqual(existingExecution, incomingExecution) &&
    isDeepStrictEqual(existing.delivery.authorIntent, incoming.delivery.authorIntent) &&
    existing.priority === incoming.priority &&
    existing.sourceCategory === incoming.sourceCategory
  );
}

function assertQueueLedgerState(entry: QueueLedgerEntry): void {
  if (entry.status === 'queued' && (entry.claimId !== undefined || entry.claimedAt !== undefined)) {
    throw new Error('queued ledger entry cannot carry a claim');
  }
  if (entry.status === 'claimed' && (!entry.claimId || entry.claimedAt === undefined)) {
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

export function assertQueueLedgerEntry(entry: QueueLedgerEntry): void {
  if (entry.version !== 1) throw new Error('unsupported queue ledger entry version');
  if (!entry.id || !entry.threadId || !entry.payload.sourceId) throw new Error('queue ledger identity is incomplete');
  if (entry.target.kind === 'cat' ? !entry.target.catId : entry.target.kind !== 'unassigned') {
    throw new Error('queue ledger target is invalid');
  }
  if (!isMessageFrom(entry.from)) throw new Error('queue ledger sender is invalid');
  if (entry.owner.kind === 'user' ? !entry.owner.userId : !entry.owner.service) {
    throw new Error('queue ledger owner is incomplete');
  }
  if (!Number.isFinite(entry.enqueuedAt) || entry.enqueuedAt < 0) throw new Error('queue ledger enqueuedAt is invalid');
  assertQueueLedgerState(entry);
}
