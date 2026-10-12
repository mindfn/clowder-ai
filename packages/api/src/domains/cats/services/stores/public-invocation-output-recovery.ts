import { createHash } from 'node:crypto';
import { normalizeJsonUnicode } from '../../../../utils/json-unicode.js';
import { snapshotPluginProtocolData } from '../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput, StoredMessage } from './ports/MessageStore.js';
import { parsePublicInvocationOutput } from './public-invocation-output.js';
import {
  assertPublicOutputReplay,
  capturePublicOutputAppend,
  PUBLIC_OUTPUT_BODY_KEYS,
} from './public-invocation-output-append.js';

export const PUBLIC_OUTPUT_QUARANTINE_REASONS = [
  'missing_canonical_child',
  'missing_terminal_proof',
  'identity_mismatch',
  'terminal_projection_mismatch',
  'append_commitment_mismatch',
  'malformed_recovery_record',
  'output_deleted',
] as const;
export type PublicOutputQuarantineReason = (typeof PUBLIC_OUTPUT_QUARANTINE_REASONS)[number];
interface RecoveryIdentity {
  readonly v: 1;
  readonly sourceMessageId: string;
  readonly childInvocationId: string;
  readonly outputMessageId: string;
  readonly appendDigest: string;
}
export type PublicOutputRecoveryV1 = RecoveryIdentity &
  (
    | { readonly state: 'pending' }
    | { readonly state: 'quarantined'; readonly reason: PublicOutputQuarantineReason; readonly recordedAt: number }
  );
export type PublicOutputRecoveryRead =
  | { kind: 'pending'; expected: AppendMessageInput }
  | { kind: 'terminal'; message: StoredMessage }
  | { kind: 'quarantined'; message: StoredMessage; reason: PublicOutputQuarantineReason }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: 'malformed_recovery_record' | 'append_commitment_mismatch' };
export interface PublicOutputRecoveryPageInput {
  readonly after?: string;
  readonly limit: number;
}
export interface PublicOutputRecoveryPage {
  ids: string[];
  nextCursor?: string;
  exhausted: boolean;
}
export interface PublicOutputRecoveryCheckpoint {
  revision: number;
  cursor: string | null;
}
export interface PublicOutputRecoveryCheckpointInput {
  readonly expectedRevision: number;
  readonly cursor: string | null;
}
export type PublicOutputRecoveryCheckpointResult = {
  kind: 'updated' | 'conflict';
  checkpoint: PublicOutputRecoveryCheckpoint;
};
export interface PublicOutputQuarantineInput {
  readonly expected: AppendMessageInput;
  readonly reason: PublicOutputQuarantineReason;
}
export type PublicOutputQuarantineResult =
  | { kind: 'updated'; message: StoredMessage }
  | { kind: 'existing'; message: StoredMessage }
  | { kind: 'terminal_won'; message: StoredMessage }
  | { kind: 'conflict' }
  | { kind: 'not_found' };

export function parsePublicOutputRecovery(value: unknown): PublicOutputRecoveryV1 | undefined {
  try {
    const row = snapshotPluginProtocolData(value) as PublicOutputRecoveryV1;
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.v !== 1) return undefined;
    if (
      !['sourceMessageId', 'childInvocationId', 'outputMessageId'].every(
        (k) =>
          typeof row[k as keyof RecoveryIdentity] === 'string' && String(row[k as keyof RecoveryIdentity]).length > 0,
      )
    )
      return undefined;
    if (typeof row.appendDigest !== 'string' || !/^[0-9a-f]{64}$/.test(row.appendDigest)) return undefined;
    if (row.state === 'pending' && Object.keys(row).length === 6) return row;
    if (
      row.state === 'quarantined' &&
      Object.keys(row).length === 8 &&
      PUBLIC_OUTPUT_QUARANTINE_REASONS.includes(row.reason) &&
      Number.isSafeInteger(row.recordedAt) &&
      row.recordedAt >= 0
    )
      return row;
    return undefined;
  } catch {
    return undefined;
  }
}
const BODY_KEYS = PUBLIC_OUTPUT_BODY_KEYS;
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, ordered(v)]),
    );
  return value;
}
/** One normal form for caller append, strict raw recovery and terminal authorization. */
export function publicOutputPendingProjection(input: AppendMessageInput): AppendMessageInput {
  const captured = capturePublicOutputAppend(input);
  const data = Object.fromEntries(BODY_KEYS.filter((k) => Object.hasOwn(captured, k)).map((k) => [k, captured[k]]));
  return snapshotPluginProtocolData(
    normalizeJsonUnicode({ ...data, threadId: captured.threadId ?? 'default', reservedId: captured.reservedId }),
  ) as AppendMessageInput;
}
export function publicOutputAppendDigest(input: AppendMessageInput): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(publicOutputPendingProjection(input))))
    .digest('hex');
}
export function createPublicOutputRecovery(input: AppendMessageInput): PublicOutputRecoveryV1 {
  const expected = publicOutputPendingProjection(input);
  const receipt = expected.extra?.publicOutputV1;
  if (!receipt) throw new TypeError('Public output recovery requires pending identity');
  return {
    v: 1,
    state: 'pending',
    sourceMessageId: receipt.sourceMessageId,
    childInvocationId: receipt.childInvocationId,
    outputMessageId: receipt.outputMessageId,
    appendDigest: publicOutputAppendDigest(expected),
  };
}
export function readPublicOutputRecoveryMessage(message: StoredMessage | null): PublicOutputRecoveryRead {
  if (!message) return { kind: 'missing' };
  try {
    const row = snapshotPluginProtocolData(message) as StoredMessage;
    const allowed = new Set<string>(['id', ...BODY_KEYS, 'visibilitySeq', 'deletedAt', 'deletedBy', '_tombstone']);
    if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error('Unknown public recovery field');
    const receipt = parsePublicInvocationOutput(row.extra?.publicOutputV1);
    if (!receipt) throw new Error('receipt');
    const { publicOutputRecoveryV1: rawRecovery, deliveryBoundary: _boundary, ...extra } = row.extra ?? {};
    const body = Object.fromEntries(BODY_KEYS.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]));
    const expected = publicOutputPendingProjection({
      ...body,
      reservedId: row.id,
      extra: { ...extra, publicOutputV1: { ...receipt, state: 'pending_terminal' } },
    } as AppendMessageInput);
    const recovery = parsePublicOutputRecovery(rawRecovery);
    const comparable = structuredClone(row);
    // A soft-deleted quarantined row remains an inspectable recovery disposition after restore.
    if (recovery?.state === 'quarantined' && !row._tombstone) {
      delete comparable.deletedAt;
      delete comparable.deletedBy;
    }
    assertPublicOutputReplay(expected, comparable);
    if (receipt.state !== 'pending_terminal') {
      if (Object.hasOwn(row.extra ?? {}, 'publicOutputRecoveryV1')) throw new Error('terminal companion');
      return { kind: 'terminal', message: structuredClone(row) };
    }
    if (
      !recovery ||
      recovery.sourceMessageId !== receipt.sourceMessageId ||
      recovery.childInvocationId !== receipt.childInvocationId ||
      recovery.outputMessageId !== row.id
    )
      throw new Error('companion');
    if (recovery.appendDigest !== publicOutputAppendDigest(expected))
      return { kind: 'malformed', reason: 'append_commitment_mismatch' };
    return recovery.state === 'quarantined'
      ? { kind: 'quarantined', message: structuredClone(row), reason: recovery.reason }
      : { kind: 'pending', expected: structuredClone(expected) };
  } catch {
    return { kind: 'malformed', reason: 'malformed_recovery_record' };
  }
}
/** No forgiving hydration: preserve every optional-field distinction and reject unknown raw shape. */
export function strictPublicOutputRawMessage(hash: Record<string, string>): StoredMessage | null {
  if (Object.keys(hash).length === 0) return null;
  const allowed = new Set<string>(['id', ...BODY_KEYS, 'visibilitySeq', 'deletedAt', 'deletedBy', '_tombstone']);
  if (Object.keys(hash).some((k) => !allowed.has(k))) throw new Error('Unknown public recovery field');
  for (const k of ['id', 'userId', 'threadId', 'catId', 'content', 'mentions', 'timestamp', 'extra', 'origin'])
    if (!Object.hasOwn(hash, k)) throw new Error('Missing public recovery field');
  const row: Record<string, unknown> = { ...hash };
  for (const k of ['contentBlocks', 'toolEvents', 'metadata', 'mentions', 'extra', 'whisperTo', 'source']) {
    if (!Object.hasOwn(hash, k)) continue;
    if (hash[k] === '' && ['contentBlocks', 'toolEvents', 'metadata'].includes(k)) delete row[k];
    else row[k] = JSON.parse(hash[k] as string);
  }
  for (const k of ['timestamp', 'visibilitySeq', 'deletedAt'])
    if (Object.hasOwn(hash, k)) {
      const n = Number(hash[k]);
      if (hash[k] === '' || !Number.isSafeInteger(n) || n < 0 || String(n) !== hash[k])
        throw new Error('Invalid public timestamp');
      row[k] = n;
    }
  if (Object.hasOwn(hash, 'mentionsUser')) {
    if (!['0', '1'].includes(hash.mentionsUser as string)) throw new Error('Invalid mentions flag');
    row.mentionsUser = hash.mentionsUser === '1';
  }
  if (Object.hasOwn(hash, '_tombstone')) {
    if (hash._tombstone !== '1') throw new Error('Invalid tombstone');
    row._tombstone = true;
  }
  // serializeExtra uses a reversible compact tracing shape.
  const extra = row.extra as Record<string, unknown>;
  const tracing = extra?.tracing as Record<string, unknown> | undefined;
  if (
    tracing &&
    typeof tracing.t === 'string' &&
    typeof tracing.s === 'string' &&
    Object.keys(tracing).every((k) => ['t', 's', 'p'].includes(k))
  )
    extra.tracing = {
      traceId: tracing.t,
      spanId: tracing.s,
      ...(tracing.p !== undefined ? { parentSpanId: tracing.p } : {}),
    };
  return snapshotPluginProtocolData(row) as StoredMessage;
}
export function readPublicOutputRecoveryRaw(hash: Record<string, string>): PublicOutputRecoveryRead {
  try {
    return readPublicOutputRecoveryMessage(strictPublicOutputRawMessage(hash));
  } catch {
    return { kind: 'malformed', reason: 'malformed_recovery_record' };
  }
}
export function capturePublicOutputQuarantine(
  id: string,
  input: PublicOutputQuarantineInput,
): PublicOutputQuarantineInput {
  const row = snapshotPluginProtocolData(input) as PublicOutputQuarantineInput;
  if (
    !row ||
    Object.keys(row).length !== 2 ||
    !PUBLIC_OUTPUT_QUARANTINE_REASONS.includes(row.reason) ||
    row.reason === 'output_deleted'
  )
    throw new TypeError('Invalid public recovery quarantine input');
  const expected = publicOutputPendingProjection(row.expected);
  if (expected.reservedId !== id) throw new TypeError('Mismatched public recovery output id');
  return { expected, reason: row.reason };
}
export function resolvePublicOutputQuarantine(
  current: StoredMessage | null,
  input: PublicOutputQuarantineInput,
  now: number,
): PublicOutputQuarantineResult {
  if (!current) return { kind: 'not_found' };
  try {
    assertPublicOutputReplay(input.expected, current);
  } catch {
    return { kind: 'conflict' };
  }
  const read = readPublicOutputRecoveryMessage(current);
  if (read.kind === 'pending' && publicOutputAppendDigest(input.expected) !== publicOutputAppendDigest(read.expected))
    return { kind: 'conflict' };
  if (read.kind === 'terminal') return { kind: 'terminal_won', message: read.message };
  if (read.kind === 'quarantined')
    return read.reason === input.reason ? { kind: 'existing', message: read.message } : { kind: 'conflict' };
  if (read.kind !== 'pending') return { kind: 'conflict' };
  const message = structuredClone(current);
  message.extra = {
    ...message.extra,
    publicOutputRecoveryV1: {
      ...createPublicOutputRecovery(read.expected),
      state: 'quarantined',
      reason: input.reason,
      recordedAt: now,
    },
  };
  return { kind: 'updated', message };
}
export function publicRecoveryCursor(seq: number): string {
  return `public-output:${seq}`;
}
export function parsePublicRecoveryCursor(value: string | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string' || !/^public-output:[1-9][0-9]*$/.test(value))
    throw new TypeError('Invalid public recovery cursor');
  const n = Number(value.slice('public-output:'.length));
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('Invalid public recovery cursor');
  return n;
}
export function capturePublicRecoveryPage(input: PublicOutputRecoveryPageInput): { afterSeq: number; limit: number } {
  const row = snapshotPluginProtocolData(input) as PublicOutputRecoveryPageInput;
  if (
    !row ||
    Object.keys(row).some((k) => !['after', 'limit'].includes(k)) ||
    !Number.isSafeInteger(row.limit) ||
    row.limit < 1 ||
    row.limit > 1000
  )
    throw new TypeError('Invalid public recovery page');
  return { afterSeq: parsePublicRecoveryCursor(row.after), limit: row.limit };
}
export function capturePublicRecoveryCheckpoint(
  input: PublicOutputRecoveryCheckpointInput,
): PublicOutputRecoveryCheckpointInput {
  const row = snapshotPluginProtocolData(input) as PublicOutputRecoveryCheckpointInput;
  if (
    !row ||
    Object.keys(row).length !== 2 ||
    !Number.isSafeInteger(row.expectedRevision) ||
    row.expectedRevision < 0 ||
    row.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    (row.cursor !== null && typeof row.cursor !== 'string')
  )
    throw new TypeError('Invalid public recovery checkpoint');
  parsePublicRecoveryCursor(row.cursor);
  return row;
}

/** Compute only the new companion; callers retain raw unrelated metadata bytes/JSON shapes. */
export function publicOutputSoftDeleteRecovery(
  message: StoredMessage,
  now: number,
): PublicOutputRecoveryV1 | undefined {
  if (!Object.hasOwn(message.extra ?? {}, 'publicOutputV1')) return undefined;
  // Repeated deletion preserves the first quarantine disposition and time.
  const comparable = structuredClone(message);
  delete comparable.deletedAt;
  delete comparable.deletedBy;
  const read = readPublicOutputRecoveryMessage(comparable);
  if (read.kind === 'terminal') return undefined;
  if (read.kind === 'quarantined') return read.message.extra?.publicOutputRecoveryV1 ?? undefined;
  if (read.kind !== 'pending') throw new Error('Cannot soft-delete malformed public recovery record');
  return {
    ...createPublicOutputRecovery(read.expected),
    state: 'quarantined',
    reason: 'output_deleted',
    recordedAt: now,
  };
}
