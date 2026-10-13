import { isDeepStrictEqual } from 'node:util';
import { type IMessageStore, isDelivered, type StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../../cats/services/stores/ports/queued-message-custody.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

/** Source facts are readable data, never a grant to invoke an agent or access owner context. */
export interface PluginSourceFact {
  readonly id: string;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string | null;
  readonly content: string;
  readonly source: {
    readonly connector: string;
    readonly meta?: Readonly<Record<string, unknown>>;
  };
  readonly extra: { readonly pluginMessage: { readonly instanceId: string } };
}
export interface PluginSourceFactsHost {
  read(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceFact>;
}
export interface PluginNativeContext {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly originTriggerMessageId: string;
  readonly source: PluginSourceFact;
}
export interface PluginNativeContextHost {
  current(): Promise<PluginNativeContext>;
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly ownerUserId: string | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById'> | undefined;
  readonly threadStore: Pick<IThreadStore, 'get'> | undefined;
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin source is unavailable to this caller');
}
function messageId(input: { readonly messageRef: `message:${string}` }): string {
  const value = snapshotPluginProtocolData(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.messageRef !== 'string' ||
    !/^message:\S{1,500}$/u.test(record.messageRef) ||
    [...record.messageRef].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    refuse();
  return record.messageRef.slice('message:'.length);
}

/** Exact origin only for native calls; Work/receipt/ancestor scopes require their own admission. */
export function createPluginSourceFactsHost(deps: Deps): {
  readonly sourceFacts: PluginSourceFactsHost;
  readonly nativeContext: PluginNativeContextHost;
} {
  function principal(nativeOnly = false) {
    const messages = deps.messageStore,
      threads = deps.threadStore;
    if (!deps.ownerUserId || !messages || !threads)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host source stores unavailable');
    const owner = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    const native = currentPluginCallContext(deps.pluginInstanceId);
    if (owner && !nativeOnly && owner.userId === deps.ownerUserId) {
      return { messages, threads, userId: owner.userId, native: undefined, checkCaller: () => owner.assertCurrent() };
    }
    if (
      !native?.assertInvocationCurrent ||
      native.userId !== deps.ownerUserId ||
      !native.invocationId ||
      !native.originTriggerMessageId ||
      !native.catId ||
      !native.threadId
    )
      refuse();
    const identity = Object.freeze({
      userId: native.userId,
      threadId: native.threadId,
      catId: native.catId,
      invocationId: native.invocationId,
      originTriggerMessageId: native.originTriggerMessageId,
    });
    const check = native.assertInvocationCurrent;
    return { messages, threads, userId: identity.userId, native: identity, checkCaller: () => check() };
  }
  type Caller = ReturnType<typeof principal>;
  async function current(caller: Caller) {
    await caller.checkCaller();
    await deps.assertCurrent(['thread.readContent']);
    await caller.checkCaller();
  }
  function assertReadableDelivery(message: StoredMessage, caller: Caller): void {
    if (isDelivered(message)) return;
    const native = caller.native;
    if (!native || message.deliveryStatus !== 'queued' || message.catId !== null) refuse();
    assertQueueCustodyMessageBinding(message);
    const custody = message.queueCustody;
    const carrier = custody?.pluginPublicInvocation;
    if (
      !custody ||
      !carrier ||
      carrier.pluginInstanceId !== deps.pluginInstanceId ||
      carrier.sourceMessageId !== message.id ||
      carrier.sourcePluginRevision !== message.extra?.pluginMessage?.revision ||
      carrier.targetCatId !== native.catId ||
      custody.ownerUserId !== caller.userId ||
      custody.status !== 'processing' ||
      custody.awakenedInvocationIdByCatId?.[native.catId] !== native.invocationId ||
      !custody.pendingTargetCats.some((catId) => catId === native.catId) ||
      custody.failedByCatIds.some((catId) => catId === native.catId) ||
      custody.handledByCatIds.some((catId) => catId === native.catId) ||
      custody.withdrawnByCatIds?.some((catId) => catId === native.catId) ||
      custody.prestartRetirement ||
      custody.steerRequestedByCatIds?.some((catId) => catId === native.catId) ||
      custody.steeredInvocationIdByCatId?.[native.catId]
    )
      refuse();
  }
  function sourceOf(message: StoredMessage | null, id: string, caller: Caller) {
    if (
      !message ||
      message.id !== id ||
      message.userId !== caller.userId ||
      (caller.native &&
        (message.id !== caller.native.originTriggerMessageId || message.threadId !== caller.native.threadId)) ||
      message.deletedAt ||
      message.recall ||
      message._tombstone ||
      message.sourceParseFailure ||
      message.extra?.pluginMessage?.instanceId !== deps.pluginInstanceId ||
      !message.source?.connector
    )
      refuse();
    // A running public child must read its exact queued origin to call the plugin's
    // native methods. This does not expose queued sources to owner or unrelated calls.
    assertReadableDelivery(message, caller);
    const projected: PluginSourceFact = {
      id: message.id,
      userId: message.userId,
      threadId: message.threadId,
      catId: message.catId,
      content: message.content,
      source: {
        connector: message.source.connector,
        ...(message.source.meta === undefined ? {} : { meta: message.source.meta }),
      },
      extra: { pluginMessage: { instanceId: deps.pluginInstanceId } },
    };
    return {
      fact: snapshotPluginProtocolData(projected) as PluginSourceFact,
      revision: message.extra.pluginMessage.revision,
    };
  }
  async function readOnce(id: string, caller: Caller) {
    await current(caller);
    const source = sourceOf(await caller.messages.getById(id), id, caller);
    await current(caller);
    const thread = await caller.threads.get(source.fact.threadId);
    await current(caller);
    if (!thread || thread.id !== source.fact.threadId || thread.createdBy !== caller.userId || thread.deletedAt)
      refuse();
    return source;
  }
  async function read(id: string, caller: Caller): Promise<PluginSourceFact> {
    // Reject an out-of-scope native pointer before even asking the message store.
    if (caller.native && caller.native.originTriggerMessageId !== id) refuse();
    const before = await readOnce(id, caller);
    const after = await readOnce(id, caller);
    if (!isDeepStrictEqual(before, after)) refuse();
    return after.fact;
  }
  return Object.freeze({
    sourceFacts: Object.freeze({
      async read(input: { readonly messageRef: `message:${string}` }) {
        return read(messageId(input), principal());
      },
    }),
    nativeContext: Object.freeze({
      async current(input?: unknown) {
        if (input !== undefined) refuse();
        const caller = principal(true);
        if (!caller.native) refuse();
        const source = await read(caller.native.originTriggerMessageId, caller);
        return Object.freeze({ ...caller.native, source });
      },
    }),
  });
}
