import { isDeepStrictEqual } from 'node:util';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { PluginPublicInvocationCarrierV1 } from '../../cats/services/stores/ports/plugin-public-invocation-carrier.js';
import { assertQueueCustodyMessageBinding } from '../../cats/services/stores/ports/queued-message-custody.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { snapshotPluginProtocolData as snapshot } from './plugin-protocol-data.js';
import {
  capturePublicVerification,
  type PublicInvocationVerifierContext,
  type PublicInvocationVerifierPort,
} from './public-invocation-verifier.js';

/** Host-only coordinates from Queue or the active child registry, never a package request body. */
export interface PublicInvocationBinding {
  readonly entryId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly targetCatId: string;
  /** Absent only for queued custody with no awakened child; processing requires the exact child. */
  readonly invocationId?: string;
}
export interface PublicInvocationSourceServices {
  readonly ownerUserId: string | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly threadStore: Pick<IThreadStore, 'get'> | undefined;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Public invocation source or custody is no longer current');
}
function bindingSnapshot(input: PublicInvocationBinding, owner: string | undefined, target: string) {
  const value = snapshot(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  const required = ['entryId', 'userId', 'threadId', 'targetCatId'];
  if (
    required.some((key) => !(key in row)) ||
    Object.keys(row).some((key) => ![...required, 'invocationId'].includes(key)) ||
    Object.values(row).some(
      (value) =>
        typeof value !== 'string' ||
        !value.length ||
        value.length > 512 ||
        value.trim() !== value ||
        [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    ) ||
    !owner ||
    row.userId !== owner ||
    row.targetCatId !== target
  )
    refuse();
  return value as unknown as PublicInvocationBinding;
}
function sourceSnapshot(
  message: StoredMessage | null,
  carrier: PluginPublicInvocationCarrierV1,
  binding: PublicInvocationBinding,
) {
  if (
    !message ||
    message.id !== carrier.sourceMessageId ||
    message.userId !== binding.userId ||
    message.threadId !== binding.threadId ||
    message.catId !== null ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.sourceParseFailure ||
    message.deliveryStatus !== 'queued' ||
    !message.source?.connector ||
    message.extra?.pluginMessage?.instanceId !== carrier.pluginInstanceId ||
    message.extra.pluginMessage.revision !== carrier.sourcePluginRevision
  )
    refuse();
  assertQueueCustodyMessageBinding(message);
  const custody = message.queueCustody;
  if (
    !custody ||
    !isDeepStrictEqual(custody.pluginPublicInvocation, carrier) ||
    custody.entryId !== binding.entryId ||
    custody.ownerUserId !== binding.userId ||
    custody.status === 'terminal' ||
    !custody.pendingTargetCats.some((catId) => catId === binding.targetCatId) ||
    custody.failedByCatIds.some((catId) => catId === binding.targetCatId) ||
    custody.handledByCatIds.some((catId) => catId === binding.targetCatId) ||
    custody.withdrawnByCatIds?.some((catId) => catId === binding.targetCatId) ||
    custody.prestartRetirement ||
    custody.steerRequestedByCatIds?.some((catId) => catId === binding.targetCatId) ||
    custody.steeredInvocationIdByCatId?.[binding.targetCatId] ||
    (binding.invocationId === undefined
      ? custody.status !== 'queued' || custody.awakenedInvocationIdByCatId?.[binding.targetCatId] !== undefined
      : custody.status !== 'processing' ||
        custody.awakenedInvocationIdByCatId?.[binding.targetCatId] !== binding.invocationId)
  )
    refuse();
  // Mutable Queue progress is checked above, not pinned as source content. No private extra is returned.
  return snapshot({ content: message.content, source: message.source, revision: carrier.sourcePluginRevision });
}

/** Read-only execution fence. This cannot admit, schedule, repair or revive a carrier. */
export async function assertDurablePublicInvocationCurrent(
  instanceId: string,
  input: PluginPublicInvocationCarrierV1,
  expected: PublicInvocationBinding,
  authority: PublicInvocationVerifierContext,
  services: PublicInvocationSourceServices | undefined,
  verify: PublicInvocationVerifierPort['invokePublicInvocationVerifier'],
): Promise<void> {
  const { carrier, context } = capturePublicVerification(instanceId, input, authority);
  const binding = bindingSnapshot(expected, services?.ownerUserId, carrier.targetCatId);
  const messages = services?.messageStore;
  const threads = services?.threadStore;
  if (!messages || !threads)
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Public invocation source stores unavailable');
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  let initialSource: unknown;
  let capturedSource = false;
  const outerCurrent = async () => {
    signal.throwIfAborted();
    await context.assertCurrent();
    signal.throwIfAborted();
  };
  const read = async () => {
    await outerCurrent();
    const source = sourceSnapshot(await messages.getById(carrier.sourceMessageId), carrier, binding);
    await outerCurrent();
    const thread = await threads.get(binding.threadId);
    await outerCurrent();
    if (
      !thread ||
      thread.id !== binding.threadId ||
      thread.createdBy !== binding.userId ||
      thread.deletedAt ||
      !thread.participants.some((catId) => catId === binding.targetCatId)
    )
      refuse();
    return source;
  };
  const assertCurrent = async () => {
    try {
      const before = await read();
      const after = await read();
      if (!isDeepStrictEqual(before, after) || (capturedSource && !isDeepStrictEqual(initialSource, after))) refuse();
      initialSource = after;
      capturedSource = true;
    } catch (error) {
      // An inner verifier cannot swallow a failed source fence and later approve this call.
      lifetime.abort(error);
      throw error;
    }
  };
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([
      (async () => {
        await assertCurrent();
        await verify(instanceId, carrier, Object.freeze({ signal, assertCurrent }));
        await assertCurrent();
      })(),
      aborted,
    ]);
  } finally {
    removeAbortListener();
    lifetime.abort();
  }
}
