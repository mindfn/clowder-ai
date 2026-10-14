import { isDeepStrictEqual } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import {
  capturePluginTaskInvocationAuth,
  type PluginTaskInvocationBinding,
} from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import { type IMessageStore, isDelivered, type StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../../cats/services/stores/ports/queued-message-custody.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { type PluginSourceProgressFact, projectPluginQueueProgress } from './plugin-source-progress.js';
import type { PluginTaskProvenance } from './plugin-task-provenance.js';
import { parseTaskExecutionV2, taskReceiptDigest } from './plugin-task-receipt.js';

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
  readProgress(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceProgressFact>;
}
export interface PluginNativeContext {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly originTriggerMessageId: string;
  readonly source: PluginSourceFact;
}
export interface PluginNativeTaskContext extends PluginNativeContext {
  readonly task: {
    readonly taskRef: `task:work:${string}`;
    readonly taskRevision: number;
    readonly admissionRef: string;
    readonly executionRef: string;
    readonly sourceRevision: number;
    readonly execution?: {
      readonly kind: 'initial' | 'owner_resume' | 'source_continuation';
      readonly firstAdmissionKind: PluginTaskProvenance['kind'];
      readonly requestKind: PluginTaskProvenance['kind'];
    };
  };
}
export interface PluginNativeContextHost {
  current(input: { readonly includeTask: true }): Promise<PluginNativeTaskContext>;
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

function queueBinding(message: StoredMessage): unknown {
  if (!message.queueCustody) return null;
  return snapshotPluginProtocolData({
    entryId: message.queueCustody.entryId,
    pluginPublicInvocation: message.queueCustody.pluginPublicInvocation ?? null,
  });
}

/** Exact origin only for native calls; Work/receipt/ancestor scopes require their own admission. */
export function createPluginSourceFactsHost(deps: Deps): {
  readonly sourceFacts: PluginSourceFactsHost;
  readonly nativeContext: PluginNativeContextHost;
} {
  function principal(nativeOnly = false, taskBinding?: PluginTaskInvocationBinding) {
    const messages = deps.messageStore,
      threads = deps.threadStore;
    if (!deps.ownerUserId || !messages || !threads)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host source stores unavailable');
    const owner = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    const native = currentPluginCallContext(deps.pluginInstanceId);
    if (owner && !nativeOnly && owner.userId === deps.ownerUserId) {
      return {
        messages,
        threads,
        userId: owner.userId,
        native: undefined,
        taskBinding: undefined,
        checkCaller: () => owner.assertCurrent(),
      };
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
    if (taskBinding) {
      if (native.ownerAuthProvenance !== 'unknown') refuse();
      taskBinding = capturePluginTaskInvocationAuth({
        ...native,
        pluginTaskBinding: taskBinding,
        catId: native.catId as CatId,
        ownerAuthProvenance: native.ownerAuthProvenance,
      }).pluginTaskBinding;
      if (!taskBinding || taskBinding.pluginInstanceId !== deps.pluginInstanceId) refuse();
    }
    const identity = Object.freeze({
      userId: native.userId,
      threadId: native.threadId,
      catId: native.catId,
      invocationId: native.invocationId,
      originTriggerMessageId: native.originTriggerMessageId,
    });
    const check = native.assertInvocationCurrent;
    return { messages, threads, userId: identity.userId, native: identity, taskBinding, checkCaller: () => check() };
  }
  type Caller = ReturnType<typeof principal>;
  async function current(caller: Caller) {
    await caller.checkCaller();
    await deps.assertCurrent(caller.taskBinding ? ['thread.readContent', 'task.read'] : ['thread.readContent']);
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
      carrier &&
      (carrier.pluginInstanceId !== deps.pluginInstanceId ||
        carrier.sourceMessageId !== message.id ||
        carrier.sourcePluginRevision !== message.extra?.pluginMessage?.revision ||
        carrier.targetCatId !== native.catId)
    )
      refuse();
    if (
      !custody ||
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
  function checkedSource(message: StoredMessage | null, id: string, caller: Caller) {
    if (
      !message ||
      message.id !== id ||
      message.userId !== caller.userId ||
      (caller.native &&
        (message.id !== (caller.taskBinding?.sourceMessageId ?? caller.native.originTriggerMessageId) ||
          (!caller.taskBinding && message.threadId !== caller.native.threadId))) ||
      (caller.taskBinding &&
        (message.extra?.pluginMessage?.revision !== caller.taskBinding.sourceRevision ||
          message.deliveryStatus === 'canceled')) ||
      message.deletedAt ||
      message.recall ||
      message._tombstone ||
      message.sourceParseFailure ||
      message.extra?.pluginMessage?.instanceId !== deps.pluginInstanceId ||
      !message.source?.connector
    )
      refuse();
    return { message, source: message.source, pluginMessage: message.extra.pluginMessage };
  }
  function sourceOf(value: StoredMessage | null, id: string, caller: Caller, progress: boolean) {
    const { message, source, pluginMessage } = checkedSource(value, id, caller);
    // A running child must read its exact queued origin to call the plugin's
    // native methods. This does not expose queued sources to owner or unrelated calls.
    if (!progress && !caller.taskBinding) assertReadableDelivery(message, caller);
    const queueProgress = progress ? projectPluginQueueProgress(message, caller.userId) : undefined;
    const projected = {
      id: message.id,
      userId: message.userId,
      threadId: message.threadId,
      catId: message.catId,
      ...(progress ? {} : { content: message.content }),
      ...(queueProgress === undefined ? {} : { queueCustody: queueProgress }),
      source: {
        connector: source.connector,
        ...(source.meta === undefined ? {} : { meta: source.meta }),
      },
      extra: { pluginMessage: { instanceId: deps.pluginInstanceId } },
    };
    return {
      fact: snapshotPluginProtocolData(projected) as PluginSourceFact | PluginSourceProgressFact,
      revision: pluginMessage.revision,
      ...(progress
        ? { queueRevision: message.queueCustody?.revision ?? null, deliveryStatus: message.deliveryStatus ?? null }
        : {}),
      // Keep the same Queue admission across both reads, including any public
      // carrier. Ordinary send(wake) uses the existing generic Queue admission.
      queueBinding: queueBinding(message),
    };
  }
  async function readOnce(id: string, caller: Caller, progress: boolean) {
    await current(caller);
    const source = sourceOf(await caller.messages.getById(id), id, caller, progress);
    await current(caller);
    const thread = await caller.threads.get(source.fact.threadId);
    await current(caller);
    if (!thread || thread.id !== source.fact.threadId || thread.createdBy !== caller.userId || thread.deletedAt)
      refuse();
    if (caller.taskBinding) {
      const taskThread = await caller.threads.get(caller.taskBinding.threadId);
      await current(caller);
      if (
        !taskThread ||
        taskThread.id !== caller.taskBinding.threadId ||
        taskThread.createdBy !== caller.userId ||
        taskThread.deletedAt
      )
        refuse();
    }
    return source;
  }
  async function read(id: string, caller: Caller): Promise<PluginSourceFact>;
  async function read(id: string, caller: Caller, progress: true): Promise<PluginSourceProgressFact>;
  async function read(
    id: string,
    caller: Caller,
    progress = false,
  ): Promise<PluginSourceFact | PluginSourceProgressFact> {
    // Reject an out-of-scope native pointer before even asking the message store.
    if (caller.native && (caller.taskBinding?.sourceMessageId ?? caller.native.originTriggerMessageId) !== id) refuse();
    const before = await readOnce(id, caller, progress);
    const after = await readOnce(id, caller, progress);
    if (!isDeepStrictEqual(before, after)) refuse();
    return after.fact;
  }
  async function currentNative(input: { readonly includeTask: true }): Promise<PluginNativeTaskContext>;
  async function currentNative(): Promise<PluginNativeContext>;
  async function currentNative(input?: unknown): Promise<PluginNativeContext | PluginNativeTaskContext> {
    const request = input === undefined ? undefined : snapshotPluginProtocolData(input);
    if (
      request !== undefined &&
      (!request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).length !== 1 ||
        !('includeTask' in request) ||
        request.includeTask !== true)
    )
      refuse();
    let taskBinding: PluginTaskInvocationBinding | undefined;
    if (request !== undefined) {
      const native = currentPluginCallContext(deps.pluginInstanceId);
      if (!native?.readTaskBinding) refuse();
      taskBinding = await native.readTaskBinding();
      if (!taskBinding) refuse();
    }
    const caller = principal(true, taskBinding);
    if (!caller.native) refuse();
    const binding = caller.taskBinding;
    const source = await read(binding?.sourceMessageId ?? caller.native.originTriggerMessageId, caller);
    let execution: PluginNativeTaskContext['task']['execution'];
    if (binding?.version === 2) {
      await current(caller);
      const receipt = await caller.messages.getById(binding.executionRef.slice(8));
      await current(caller);
      if (!receipt || taskReceiptDigest(receipt.content) !== binding.executionReceiptDigest) refuse();
      const data = parseTaskExecutionV2(receipt.content);
      execution = {
        kind: data.executionKind,
        firstAdmissionKind: data.firstAdmission.kind,
        requestKind: data.request.kind,
      };
    }
    return snapshotPluginProtocolData({
      ...caller.native,
      source,
      ...(binding
        ? {
            task: {
              taskRef: `task:work:${binding.taskId}`,
              taskRevision: binding.taskRevision,
              admissionRef: binding.admissionRef,
              executionRef: binding.executionRef,
              sourceRevision: binding.sourceRevision,
              ...(execution ? { execution } : {}),
            },
          }
        : {}),
    }) as PluginNativeContext | PluginNativeTaskContext;
  }
  return Object.freeze({
    sourceFacts: Object.freeze({
      async read(input: { readonly messageRef: `message:${string}` }) {
        return read(messageId(input), principal());
      },
      async readProgress(input: { readonly messageRef: `message:${string}` }) {
        const caller = principal();
        if (caller.native) refuse();
        return read(messageId(input), caller, true);
      },
    }),
    nativeContext: Object.freeze({ current: currentNative }),
  });
}
