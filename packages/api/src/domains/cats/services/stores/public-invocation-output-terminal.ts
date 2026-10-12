import { isDeepStrictEqual } from 'node:util';
import { normalizeJsonUnicode } from '../../../../utils/json-unicode.js';
import { snapshotPluginProtocolData } from '../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput, StoredMessage } from './ports/MessageStore.js';
import { parsePublicInvocationOutput } from './public-invocation-output.js';
import { assertPublicOutputReplay } from './public-invocation-output-append.js';
import {
  publicOutputAppendDigest,
  publicOutputPendingProjection,
  readPublicOutputRecoveryMessage,
} from './public-invocation-output-recovery.js';

/** Mechanical storage fence only. The caller must verify canonical child/auth terminal authority. */
export interface PublicOutputTransitionInput {
  readonly expected: AppendMessageInput;
  readonly nextState: 'committed' | 'abandoned';
}
export type PublicOutputTransitionResult =
  | { kind: 'updated' | 'existing'; message: StoredMessage }
  | { kind: 'not_found' | 'conflict' };

function reject(): never {
  throw new TypeError('Public output terminal transition requires an exact pending append snapshot');
}

/** Reject accessors and capture all caller-controlled data before storage I/O. */
export function capturePublicOutputTransition(
  id: string,
  input: PublicOutputTransitionInput,
): PublicOutputTransitionInput {
  try {
    const row = snapshotPluginProtocolData(input) as PublicOutputTransitionInput;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2) reject();
    if (row.nextState !== 'committed' && row.nextState !== 'abandoned') reject();
    const expected = publicOutputPendingProjection(row.expected);
    if (!parsePublicInvocationOutput(expected.extra?.publicOutputV1) || expected.reservedId !== id) reject();
    // Match the append path's Unicode normalization, then freeze that normalized snapshot too.
    return snapshotPluginProtocolData(
      normalizeJsonUnicode({ expected, nextState: row.nextState }),
    ) as PublicOutputTransitionInput;
  } catch {
    reject();
  }
}

/** History hydration is intentionally forgiving; terminal proof must not erase malformed raw presence. */
export function publicOutputRawBodyMatchesExpected(
  hash: Record<string, string>,
  expected: AppendMessageInput,
): boolean {
  if (
    ['deletedAt', '_tombstone', 'recall', 'queueCustody', 'queueCustodyAdmission', 'deliveryStatus'].some((field) =>
      Object.hasOwn(hash, field),
    )
  )
    return false;
  if (
    ['id', 'userId', 'threadId', 'catId', 'timestamp', 'content', 'mentions', 'extra', 'origin'].some(
      (field) => !Object.hasOwn(hash, field),
    )
  )
    return false;
  try {
    for (const key of ['mentions', 'contentBlocks', 'toolEvents', 'metadata'] as const) {
      // The append serializer writes absent optional JSON fields as empty strings.
      // Mentions is required JSON; nonempty malformed optional values must still fail closed.
      const raw = hash[key];
      const absent = !Object.hasOwn(hash, key) || (key !== 'mentions' && raw === '');
      const value = absent ? undefined : JSON.parse(raw as string);
      if (!isDeepStrictEqual(value, expected[key])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Pure decision shared by memory and Redis; the latter must still CAS the complete raw hash. */
export function resolvePublicOutputTransition(
  current: StoredMessage | null,
  input: PublicOutputTransitionInput,
): PublicOutputTransitionResult {
  if (!current) return { kind: 'not_found' };
  if (
    current.deliveryStatus !== undefined ||
    current.queueCustody !== undefined ||
    current.queueCustodyAdmission !== undefined
  )
    return { kind: 'conflict' };
  try {
    assertPublicOutputReplay(input.expected, current);
  } catch {
    return { kind: 'conflict' };
  }
  const receipt = parsePublicInvocationOutput(current.extra?.publicOutputV1);
  if (!receipt) return { kind: 'conflict' };
  const recovery = readPublicOutputRecoveryMessage(current);
  if (receipt.state === input.nextState && recovery.kind === 'terminal')
    return { kind: 'existing', message: structuredClone(current) };
  if (
    recovery.kind !== 'pending' ||
    publicOutputAppendDigest(input.expected) !== publicOutputAppendDigest(recovery.expected)
  )
    return { kind: 'conflict' };
  if (receipt.state !== 'pending_terminal') return { kind: 'conflict' };
  const message = structuredClone(current);
  message.extra = { ...message.extra, publicOutputV1: { ...receipt, state: input.nextState } };
  delete message.extra.publicOutputRecoveryV1;
  if (input.nextState === 'committed') message.extra.deliveryBoundary = structuredClone(receipt.boundary);
  return { kind: 'updated', message };
}
