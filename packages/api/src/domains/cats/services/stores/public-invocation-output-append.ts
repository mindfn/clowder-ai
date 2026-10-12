import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput, StoredMessage } from './ports/MessageStore.js';
import {
  committedPublicInvocationOutput,
  hasPublicInvocationOutput,
  parsePublicInvocationOutput,
  publicInvocationOutputMatchesMessage,
} from './public-invocation-output.js';

function reject(): never {
  throw new TypeError('Public invocation output requires an exact pending append or matching idempotent identity');
}

/** Capture public data before Unicode normalization, idempotency reads, listeners or Redis awaits. */
export function capturePublicOutputAppend(input: AppendMessageInput, allowPublic = true): AppendMessageInput {
  const extraProperty = Object.getOwnPropertyDescriptor(input, 'extra');
  if ('extra' in input && (!extraProperty || !('value' in extraProperty))) reject();
  if (!hasPublicInvocationOutput(extraProperty?.value)) return input;
  if (!allowPublic) reject();
  let captured: AppendMessageInput;
  try {
    captured = snapshotPluginProtocolData(input) as AppendMessageInput;
  } catch {
    reject();
  }
  const receipt = parsePublicInvocationOutput(captured.extra?.publicOutputV1);
  if (!receipt || receipt.state !== 'pending_terminal' || !captured.reservedId) reject();
  if (
    'deliveryBoundary' in (captured.extra ?? {}) ||
    captured.deliveryStatus !== undefined ||
    captured.queueCustody !== undefined ||
    captured.queueCustodyAdmission !== undefined
  )
    reject();
  const message = { ...captured, id: captured.reservedId, threadId: captured.threadId ?? 'default' };
  if (!publicInvocationOutputMatchesMessage(message, receipt)) reject();
  return captured;
}

/** A token collision must not return a different lane, receipt or body. Terminal replay never rewrites state. */
export function assertPublicOutputReplay(input: AppendMessageInput, existing: StoredMessage): void {
  const requestedPublic = hasPublicInvocationOutput(input.extra);
  const existingPublic = hasPublicInvocationOutput(existing.extra);
  if (!requestedPublic && !existingPublic) return;
  if (!requestedPublic || !existingPublic) reject();
  const requested = parsePublicInvocationOutput(input.extra?.publicOutputV1);
  const current = parsePublicInvocationOutput(existing.extra?.publicOutputV1);
  if (!requested || !current || !publicInvocationOutputMatchesMessage(existing, current)) reject();
  if (
    current.state === 'committed'
      ? !committedPublicInvocationOutput(existing)
      : 'deliveryBoundary' in (existing.extra ?? {})
  )
    reject();
  if (!isDeepStrictEqual({ ...current, state: 'pending_terminal' }, requested)) reject();
  for (const key of [
    'content',
    'contentBlocks',
    'thinking',
    'toolEvents',
    'metadata',
    'mentions',
    'timestamp',
    'replyTo',
  ] as const) {
    if (!isDeepStrictEqual(input[key], existing[key])) reject();
  }
  const { publicOutputV1: _inputReceipt, deliveryBoundary: _inputBoundary, ...inputExtra } = input.extra ?? {};
  const { publicOutputV1: _storedReceipt, deliveryBoundary: _storedBoundary, ...storedExtra } = existing.extra ?? {};
  if (!isDeepStrictEqual(inputExtra, storedExtra)) reject();
}
