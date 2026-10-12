import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import { authTerminalFromTurnExecution } from './CallbackAuthTurnExecutionProjection.js';
import type { InvocationRecord } from './InvocationRegistry.js';
import { capturePublicInvocationAuth } from './public-invocation-auth-binding.js';

export type PublicOutputTerminalDecision =
  | { kind: 'committed' }
  | { kind: 'abandoned' }
  | { kind: 'deferred'; reason: 'child_running' | 'auth_reconciliation_pending' }
  | {
      kind: 'conflict';
      reason:
        | 'missing_canonical_child'
        | 'missing_terminal_proof'
        | 'identity_mismatch'
        | 'terminal_projection_mismatch';
    };

const authFields = [
  'invocationId',
  'parentInvocationId',
  'userId',
  'threadId',
  'catId',
  'ownerAuthProvenance',
  'managedWorkBinding',
  'a2aTriggerMessageId',
  'originTriggerMessageId',
  'publicInvocationBinding',
  'toolExecutionPolicy',
  'state',
  'endedAt',
  'endReason',
  'terminalRef',
] as const;
export type PublicOutputAuthProof = Pick<InvocationRecord, (typeof authFields)[number]>;

/** Exclude callback secrets and mutable operational sets; never execute a record accessor. */
export function capturePublicOutputAuthProof(record: InvocationRecord): PublicOutputAuthProof {
  if (!record || ![null, Object.prototype].includes(Object.getPrototypeOf(record)))
    throw new Error('Invalid public output auth proof');
  const result: Record<string, unknown> = {};
  for (const key of authFields) {
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (property && !('value' in property)) throw new Error('Invalid public output auth proof');
    if (property?.value !== undefined) result[key] = property.value;
  }
  return snapshotPluginProtocolData(result) as PublicOutputAuthProof;
}

function sameExecutionScope(
  expected: AppendMessageInput,
  record: PublicOutputAuthProof | TurnExecutionRecord,
): boolean {
  const receipt = expected.extra?.publicOutputV1;
  return Boolean(
    receipt &&
      record.invocationId === receipt.childInvocationId &&
      record.parentInvocationId === expected.extra?.stream?.invocationId &&
      record.userId === expected.userId &&
      record.threadId === expected.threadId &&
      record.catId === expected.catId,
  );
}
function exactChild(expected: AppendMessageInput, child: TurnExecutionRecord): boolean {
  return (
    sameExecutionScope(expected, child) &&
    child.executionKind === 'ordinary' &&
    child.queueCompletionPolicy === 'explicit_source' &&
    child.causal?.triggerMessageId === expected.extra?.publicOutputV1?.sourceMessageId &&
    isDeepStrictEqual(child.causal?.coveredMessageIds, [expected.extra?.publicOutputV1?.sourceMessageId]) &&
    child.causal?.freshnessSupplementId === undefined &&
    child.causal?.routingGuardReason === undefined &&
    Number.isFinite(child.startedAt) &&
    child.startedAt >= 0
  );
}
function exactAuth(expected: AppendMessageInput, auth: PublicOutputAuthProof): boolean {
  if (!sameExecutionScope(expected, auth) || !auth.publicInvocationBinding) return false;
  capturePublicInvocationAuth(auth);
  return auth.publicInvocationBinding.carrier.sourceMessageId === expected.extra?.publicOutputV1?.sourceMessageId;
}
function exactProjection(child: TurnExecutionRecord, auth: PublicOutputAuthProof): boolean {
  if (
    !['succeeded', 'failed', 'canceled', 'interrupted'].includes(child.status) ||
    child.endedAt === undefined ||
    !Number.isFinite(child.endedAt) ||
    child.endedAt < child.startedAt ||
    (child.status !== 'succeeded' && !child.terminalReason) ||
    (child.terminalReason !== undefined &&
      (typeof child.terminalReason !== 'string' || child.terminalReason.length === 0))
  )
    return false;
  const projection = authTerminalFromTurnExecution(child);
  return (
    auth.state === projection.disposition &&
    auth.endedAt === projection.endedAt &&
    auth.endReason === projection.endReason &&
    auth.terminalRef === projection.terminalRef
  );
}

/** Immutable identity and terminal truth only; source currentness remains an execution/settlement fence. */
export function decidePublicOutputTerminal(
  expected: AppendMessageInput,
  child: TurnExecutionRecord | null,
  auth: PublicOutputAuthProof | null,
): PublicOutputTerminalDecision {
  if (!child) return { kind: 'conflict', reason: 'missing_canonical_child' };
  if (!auth) return { kind: 'conflict', reason: 'missing_terminal_proof' };
  try {
    if (!exactChild(expected, child) || !exactAuth(expected, auth))
      return { kind: 'conflict', reason: 'identity_mismatch' };
  } catch {
    return { kind: 'conflict', reason: 'identity_mismatch' };
  }
  if (child.status === 'running') return { kind: 'deferred', reason: 'child_running' };
  if (auth.state === 'active') return { kind: 'deferred', reason: 'auth_reconciliation_pending' };
  if (!exactProjection(child, auth)) return { kind: 'conflict', reason: 'terminal_projection_mismatch' };
  return child.status === 'succeeded' ? { kind: 'committed' } : { kind: 'abandoned' };
}
