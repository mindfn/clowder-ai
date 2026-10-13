export { assertUnstartedTaskCustody } from '../../cats/services/agents/invocation/plugin-task-queue-state.js';

import { isDeepStrictEqual } from 'node:util';
import {
  capturePluginTaskBinding,
  type PluginTaskInvocationBinding,
} from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import {
  assertQueueCustodyTransition,
  cloneQueuedMessageCustody,
} from '../../cats/services/stores/ports/queued-message-custody.js';
import { pluginTaskDispatchContent } from './plugin-task-receipt.js';

export type PluginTaskAuthorityPhase =
  | { readonly kind: 'queue'; readonly entryId: string }
  | { readonly kind: 'invocation'; readonly invocationId: string };

export interface PluginTaskQueueSelection {
  readonly messageId: string;
  readonly entryId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly targetCatId: string;
}

function refuse(): never {
  throw new Error('Host Task Queue authority rejected');
}
function coordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
function capture(input: PluginTaskQueueSelection): PluginTaskQueueSelection {
  const { messageId, entryId, userId, threadId, targetCatId } = input;
  const result = { messageId, entryId, userId, threadId, targetCatId };
  if (!Object.values(result).every(coordinate)) refuse();
  return Object.freeze(result);
}

function decode(message: StoredMessage | null, selected: PluginTaskQueueSelection): PluginTaskInvocationBinding {
  if (
    !message ||
    message.id !== selected.messageId ||
    message.userId !== selected.userId ||
    message.threadId !== selected.threadId ||
    message.catId !== null ||
    message.source ||
    message.deletedAt ||
    message._tombstone ||
    message.recall ||
    message.sourceParseFailure ||
    message.deliveryStatus !== 'queued' ||
    message.queueCustody?.sourceCategory !== 'plugin_task'
  )
    refuse();
  let body: unknown;
  try {
    body = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
  } catch {
    return refuse();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'triggerMessageId' in body) refuse();
  const binding = capturePluginTaskBinding({ ...body, triggerMessageId: message.id });
  if (
    binding.ownerUserId !== selected.userId ||
    binding.threadId !== selected.threadId ||
    binding.targetCatId !== selected.targetCatId ||
    message.content !== pluginTaskDispatchContent(binding)
  )
    refuse();
  return binding;
}

export function createTaskQueueAuthority(
  store: Pick<IMessageStore, 'getById' | 'transitionQueueCustody'>,
  ownerUserId: string,
  readAuthority: (binding: PluginTaskInvocationBinding, phase: PluginTaskAuthorityPhase) => Promise<void>,
) {
  const readSnapshot = async (input: PluginTaskQueueSelection) => {
    const selected = capture(input);
    if (selected.userId !== ownerUserId) refuse();
    const before = structuredClone(await store.getById(selected.messageId));
    if (!before?.queueCustody) refuse();
    const binding = decode(before, selected);
    await readAuthority(binding, { kind: 'queue', entryId: selected.entryId });
    // Bind the returned selector to the same durable message and custody revision.
    if (!isDeepStrictEqual(before, structuredClone(await store.getById(selected.messageId)))) refuse();
    return { binding, custody: before.queueCustody };
  };
  return Object.freeze({
    read: async (input: PluginTaskQueueSelection) => (await readSnapshot(input)).binding,
    /** On any exception the caller must retire the child, even if the CAS already applied. */
    async bindChild(
      input: PluginTaskQueueSelection & {
        readonly binding: PluginTaskInvocationBinding;
        readonly invocationId: string;
      },
    ) {
      const selected = capture(input);
      const binding = capturePluginTaskBinding(input.binding);
      const invocationId = input.invocationId;
      if (!coordinate(invocationId)) refuse();
      const snapshot = await readSnapshot(selected);
      if (!isDeepStrictEqual(binding, snapshot.binding)) refuse();
      // Use exactly the custody revision authenticated above, not a fresh unchecked read.
      const current = snapshot.custody;
      const time = Math.max(Date.now(), current.updatedAt);
      const next = cloneQueuedMessageCustody(current);
      next.revision++;
      next.status = 'processing';
      next.processingStartedAt = time;
      next.updatedAt = time;
      next.awakenedInvocationIdByCatId = { [binding.targetCatId]: invocationId };
      next.awakenedAtByCatId = { [binding.targetCatId]: time };
      const initial = current.targetAttempts?.[0] ?? {
        id: `${current.entryId}:${binding.targetCatId}:1`,
        targetCatId: binding.targetCatId,
        sequence: 1,
        state: 'queued' as const,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      };
      next.targetAttempts = [
        { ...initial, state: 'starting', invocationId, updatedAt: Math.max(time, initial.updatedAt) },
      ];
      assertQueueCustodyTransition(current, { expectedRevision: current.revision, next });
      const result = await store.transitionQueueCustody(selected.messageId, {
        expectedRevision: current.revision,
        next,
      });
      if (
        result.kind !== 'updated' ||
        !isDeepStrictEqual(result.message.queueCustody, next) ||
        !isDeepStrictEqual(decode(result.message, selected), binding)
      )
        refuse();
      await readAuthority(binding, { kind: 'invocation', invocationId });
      const canonical = await store.getById(selected.messageId);
      if (!isDeepStrictEqual(canonical?.queueCustody, next) || !isDeepStrictEqual(decode(canonical, selected), binding))
        refuse();
      return { kind: 'bound' as const, custody: cloneQueuedMessageCustody(next) };
    },
  });
}
