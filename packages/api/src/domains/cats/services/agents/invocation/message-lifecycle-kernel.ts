import { isDeepStrictEqual } from 'node:util';
import type {
  LifecycleDispatchRef,
  LifecycleMessageFrom,
  LifecycleQueueSnapshot,
  LifecycleResponseBubble,
  LifecycleWriterEpoch,
  LifecycleWriterEpochState,
  MessageContent,
  ReorderVisibleLifecycleEntriesCommand,
} from '@cat-cafe/shared';
import { MessageContentsSchema } from '@cat-cafe/shared';

export type LifecycleQueueEntryValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLifecycleMessageFrom(value: unknown): value is LifecycleMessageFrom {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'user':
      return isNonEmptyString(value.userId);
    case 'agent':
      return isNonEmptyString(value.catId);
    case 'external':
      return (
        isNonEmptyString(value.connectorId) &&
        (value.sender === undefined ||
          (isRecord(value.sender) &&
            isNonEmptyString(value.sender.id) &&
            (value.sender.name === undefined || typeof value.sender.name === 'string'))) &&
        (value.address === undefined ||
          (isRecord(value.address) &&
            isNonEmptyString(value.address.chatId) &&
            (value.address.messageId === undefined || isNonEmptyString(value.address.messageId))))
      );
    case 'plugin':
      return isNonEmptyString(value.instanceId);
    case 'system':
      return isNonEmptyString(value.service);
    default:
      return false;
  }
}

function validateTargets(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function isValidInlinePayload(value: Record<string, unknown>): boolean {
  return value.type === 'inline' && MessageContentsSchema.safeParse(value.body).success;
}

/** Validate the discriminated Queue envelope before any owner lookup or client effect. */
function validateLifecycleQueueEntryBase(value: Record<string, unknown>): string | undefined {
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.threadId)) {
    return 'invalid_identity';
  }
  if (!isLifecycleMessageFrom(value.from)) return 'invalid_from';
  if (!validateTargets(value.targets)) return 'invalid_targets';
  if (!['strict', 'compatibility_fallback', 'unknown'].includes(String(value.ownerAuthProvenance))) {
    return 'invalid_owner_auth_provenance';
  }
  if (value.priority !== 'urgent' && value.priority !== 'normal') {
    return 'invalid_priority';
  }
  if (typeof value.enqueuedAt !== 'number' || !Number.isFinite(value.enqueuedAt)) {
    return 'invalid_enqueued_at';
  }
  if (value.position !== undefined && (!Number.isInteger(value.position) || (value.position as number) < 0)) {
    return 'invalid_position';
  }
  if (!isRecord(value.payload)) return 'invalid_payload';
  return undefined;
}

export function validateLifecycleQueueEntry(value: unknown): LifecycleQueueEntryValidation {
  if (!isRecord(value)) return { valid: false, reason: 'entry_not_object' };
  const baseFailure = validateLifecycleQueueEntryBase(value);
  if (baseFailure) return { valid: false, reason: baseFailure };
  const payload = value.payload as Record<string, unknown>;
  const targets = value.targets as readonly string[];

  switch (value.kind) {
    case 'conversation_input':
      return isValidInlinePayload(payload) && isNonEmptyString(value.sourceRecordId)
        ? { valid: true }
        : { valid: false, reason: 'invalid_conversation_input' };
    case 'message_wake':
      return payload.type === 'message_ref' &&
        isNonEmptyString(payload.messageId) &&
        targets.length > 0 &&
        value.sourceRecordId === undefined
        ? { valid: true }
        : { valid: false, reason: 'invalid_message_wake' };
    case 'private_input':
      return isValidInlinePayload(payload) &&
        targets.length > 0 &&
        value.position === undefined &&
        value.sourceRecordId === undefined
        ? { valid: true }
        : { valid: false, reason: 'invalid_private_input' };
    default:
      return { valid: false, reason: 'invalid_kind' };
  }
}

export type ApplyVisibleQueueOrderResult =
  | { readonly outcome: 'applied'; readonly snapshot: LifecycleQueueSnapshot }
  | {
      readonly outcome: 'conflict';
      readonly reason:
        | 'stale_revision'
        | 'invalid_revision'
        | 'invalid_snapshot'
        | 'scope_mismatch'
        | 'invalid_order'
        | 'visible_set_changed';
    };

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

/** Apply a complete visible-row reorder as one immutable revision transition. */
export function applyVisibleQueueOrder(
  snapshot: LifecycleQueueSnapshot,
  command: ReorderVisibleLifecycleEntriesCommand,
  nextRevision: string,
): ApplyVisibleQueueOrderResult {
  if (command.expectedQueueRevision !== snapshot.revision) {
    return { outcome: 'conflict', reason: 'stale_revision' };
  }
  if (!isNonEmptyString(nextRevision) || nextRevision === snapshot.revision) {
    return { outcome: 'conflict', reason: 'invalid_revision' };
  }
  if (
    !isNonEmptyString(snapshot.revision) ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.some((entry) => !validateLifecycleQueueEntry(entry).valid) ||
    new Set(snapshot.entries.map((entry) => entry.id)).size !== snapshot.entries.length
  ) {
    return { outcome: 'conflict', reason: 'invalid_snapshot' };
  }
  if (snapshot.entries.some((entry) => entry.threadId !== command.threadId)) {
    return { outcome: 'conflict', reason: 'scope_mismatch' };
  }
  if (new Set(command.orderedVisibleEntryIds).size !== command.orderedVisibleEntryIds.length) {
    return { outcome: 'conflict', reason: 'invalid_order' };
  }
  if (new Set(snapshot.reorderableVisibleEntryIds).size !== snapshot.reorderableVisibleEntryIds.length) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }
  if (!sameStringSet(snapshot.reorderableVisibleEntryIds, command.orderedVisibleEntryIds)) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }

  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  if (
    command.orderedVisibleEntryIds.some((entryId) => {
      const entry = byId.get(entryId);
      return !entry || entry.kind === 'private_input';
    })
  ) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }

  const positions = new Map(command.orderedVisibleEntryIds.map((entryId, position) => [entryId, position]));
  return {
    outcome: 'applied',
    snapshot: {
      revision: nextRevision,
      reorderableVisibleEntryIds: [...command.orderedVisibleEntryIds],
      entries: snapshot.entries.map((entry) => {
        const position = positions.get(entry.id);
        return position === undefined ? { ...entry } : { ...entry, position };
      }),
    },
  };
}

export type AdvanceDispatchRefResult =
  | { readonly outcome: 'applied' | 'replayed'; readonly ref: LifecycleDispatchRef }
  | { readonly outcome: 'conflict'; readonly reason: 'target_mismatch' | 'status_mismatch' | 'phase_regression' };

function sameDispatchRef(left: LifecycleDispatchRef, right: LifecycleDispatchRef): boolean {
  return (
    left.targetId === right.targetId &&
    left.phase === right.phase &&
    (left.phase === 'assigned' || (right.phase !== 'assigned' && left.statusMessageId === right.statusMessageId))
  );
}

/** Monotonic derived projection reducer; it never terminalizes a canonical owner. */
export function advanceDispatchRef(
  current: LifecycleDispatchRef,
  next: LifecycleDispatchRef,
): AdvanceDispatchRefResult {
  if (current.targetId !== next.targetId) return { outcome: 'conflict', reason: 'target_mismatch' };
  if (sameDispatchRef(current, next)) return { outcome: 'replayed', ref: current };
  if (current.phase === next.phase) {
    return { outcome: 'conflict', reason: 'status_mismatch' };
  }
  if (current.phase === 'settled' || next.phase === 'assigned') {
    return { outcome: 'conflict', reason: 'phase_regression' };
  }
  if (current.phase === 'dispatched' && next.phase === 'settled' && current.statusMessageId !== next.statusMessageId) {
    return { outcome: 'conflict', reason: 'status_mismatch' };
  }
  return { outcome: 'applied', ref: next };
}

export interface LifecycleTerminalInput {
  readonly status: Exclude<LifecycleResponseBubble['status'], 'processing'>;
  readonly body: readonly MessageContent[];
  readonly completedAt: number;
  readonly reason?: string;
}

export type ApplyLifecycleTerminalResult =
  | { readonly outcome: 'applied' | 'replayed'; readonly bubble: LifecycleResponseBubble }
  | { readonly outcome: 'conflict'; readonly reason: 'different_terminal' | 'invalid_terminal' };

function sameTerminal(bubble: LifecycleResponseBubble, terminal: LifecycleTerminalInput): boolean {
  return (
    bubble.status === terminal.status &&
    bubble.completedAt === terminal.completedAt &&
    bubble.reason === terminal.reason &&
    isDeepStrictEqual(bubble.body, terminal.body)
  );
}

/** Commit/replay the one durable delivery-result terminal for an admitted bubble. */
export function applyLifecycleTerminal(
  bubble: LifecycleResponseBubble,
  terminal: LifecycleTerminalInput,
): ApplyLifecycleTerminalResult {
  if (
    !['completed', 'failed', 'canceled', 'interrupted'].includes(terminal.status) ||
    !MessageContentsSchema.safeParse(terminal.body).success ||
    !Number.isFinite(terminal.completedAt) ||
    terminal.completedAt < bubble.startedAt
  ) {
    return { outcome: 'conflict', reason: 'invalid_terminal' };
  }
  if (bubble.status !== 'processing') {
    return sameTerminal(bubble, terminal)
      ? { outcome: 'replayed', bubble }
      : { outcome: 'conflict', reason: 'different_terminal' };
  }
  return { outcome: 'applied', bubble: { ...bubble, ...terminal } };
}

export interface LifecycleWriterEpochTransition {
  readonly expectedEpoch: LifecycleWriterEpoch;
  readonly nextEpoch: Exclude<LifecycleWriterEpoch, 'legacy'>;
  readonly migrationLeaseId: string;
  readonly cleanScan?: boolean;
}

export type LifecycleWriterEpochTransitionResult =
  | { readonly outcome: 'applied' | 'replayed'; readonly state: LifecycleWriterEpochState }
  | { readonly outcome: 'conflict'; readonly reason: 'stale_epoch' | 'invalid_transition' | 'lease_mismatch' }
  | { readonly outcome: 'blocked'; readonly reason: 'migration_not_clean' };

type ValidLifecycleWriterEpochTransition = { readonly kind: 'start_migration' } | { readonly kind: 'activate_live' };

function validateLifecycleWriterEpochTransition(
  transition: LifecycleWriterEpochTransition,
): ValidLifecycleWriterEpochTransition | LifecycleWriterEpochTransitionResult {
  if (!isNonEmptyString(transition.migrationLeaseId)) {
    return { outcome: 'conflict', reason: 'lease_mismatch' };
  }
  if (transition.expectedEpoch === 'legacy' && transition.nextEpoch === 'migrating') {
    return { kind: 'start_migration' };
  }
  if (transition.expectedEpoch !== 'migrating' || transition.nextEpoch !== 'live') {
    return { outcome: 'conflict', reason: 'invalid_transition' };
  }
  if (transition.cleanScan !== true) return { outcome: 'blocked', reason: 'migration_not_clean' };
  return { kind: 'activate_live' };
}

/** Content-free writer fence reducer. Persistence/CAS is supplied by the owning store. */
export function transitionLifecycleWriterEpoch(
  state: LifecycleWriterEpochState,
  transition: LifecycleWriterEpochTransition,
): LifecycleWriterEpochTransitionResult {
  const validated = validateLifecycleWriterEpochTransition(transition);
  if ('outcome' in validated) return validated;
  if (state.epoch === transition.nextEpoch) {
    if (state.migrationLeaseId !== transition.migrationLeaseId) {
      return { outcome: 'conflict', reason: 'lease_mismatch' };
    }
    return { outcome: 'replayed', state };
  }
  if (state.epoch !== transition.expectedEpoch) return { outcome: 'conflict', reason: 'stale_epoch' };
  if (validated.kind === 'start_migration' && state.epoch === 'legacy') {
    return {
      outcome: 'applied',
      state: { epoch: 'migrating', migrationLeaseId: transition.migrationLeaseId },
    };
  }
  if (validated.kind === 'activate_live' && state.epoch === 'migrating') {
    if (state.migrationLeaseId !== transition.migrationLeaseId) {
      return { outcome: 'conflict', reason: 'lease_mismatch' };
    }
    return {
      outcome: 'applied',
      state: { epoch: 'live', migrationLeaseId: transition.migrationLeaseId },
    };
  }
  return { outcome: 'conflict', reason: 'invalid_transition' };
}

export type {
  LifecycleQueueOrderKey,
  QueueOrderShadowComparison,
  QueueOrderShadowSummary,
} from './message-lifecycle-queue-order.js';
export {
  compareLifecycleQueueEntries,
  compareQueueOrderShadow,
  rememberBoundedShadowScope,
  summarizeQueueOrderShadow,
} from './message-lifecycle-queue-order.js';
