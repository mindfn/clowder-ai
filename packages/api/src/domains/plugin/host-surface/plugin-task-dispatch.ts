import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InvocationQueue, QueueEntry } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { PluginTaskExecutionBinding } from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import { createInitialQueuedMessageCustody } from '../../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../../cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueuedMessageCustody,
} from '../../cats/services/stores/ports/queued-message-custody.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { currentOwnerOperation } from '../carrier/plugin-owner-operation-context.js';
import { currentPluginTransportPurpose } from '../carrier/plugin-transport-context.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { capturePluginTaskDispatchSelection, type PluginTaskDispatchSelection } from './plugin-task-currentness.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import { pluginTaskDispatchContent, pluginTaskDispatchKey } from './plugin-task-receipt.js';

export interface PluginTaskQueueServices {
  readonly queue: InvocationQueue;
  resume(threadId: string, userId: string): Promise<void>;
}
export interface PluginTaskDispatchServices extends PluginTaskQueueServices {
  readonly messageStore: Pick<
    IMessageStore,
    'getById' | 'getByIdempotencyKey' | 'appendIdempotent' | 'prepareQueueAdmission' | 'initializeQueueCustody'
  >;
  readAuthority(input: PluginTaskDispatchSelection): Promise<PluginTaskExecutionBinding>;
}
export interface PluginTaskDispatchResult {
  readonly messageRef: `message:${string}`;
  readonly entryId: string;
  readonly status: 'queued' | 'processing' | 'terminal';
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Host Task dispatch unavailable or changed');
}
/** Queue a Host-authenticated execution receipt; input selectors never supply authority coordinates. */
export async function dispatchPluginEntrustedTask(
  deps: PluginTaskHostDeps,
  raw: PluginTaskDispatchSelection,
): Promise<PluginTaskDispatchResult> {
  const input = capturePluginTaskDispatchSelection(raw);
  const services = deps.dispatch,
    admission = deps.admission,
    instanceId = deps.pluginInstanceId,
    userId = deps.ownerUserId;
  if (!services || !admission || !instanceId || !userId || !deps.effectiveGrants.includes('task.admitEntrusted'))
    refuse();
  if (currentPluginTransportPurpose() === 'browser' || currentPluginTransportPurpose() === 'verifier') refuse();
  const native = currentPluginCallContext(instanceId),
    owner = currentPluginOwnerRequestContext(instanceId),
    operation = currentOwnerOperation(instanceId);
  if ((owner && (owner.userId !== userId || owner.operation !== 'write')) || (operation && operation.userId !== userId))
    refuse();
  const current = async () => {
    await deps.assertCurrent?.();
    await admission.assertCurrent();
    await native?.assertCurrent();
    await owner?.assertCurrent();
    await operation?.assertCurrent();
    await admission.assertCurrent();
  };
  await current();
  const binding = await services.readAuthority(input);
  if (binding.pluginInstanceId !== instanceId || binding.ownerUserId !== userId) refuse();
  if (
    native &&
    (native.userId !== userId ||
      native.catId !== binding.targetCatId ||
      native.originTriggerMessageId !== binding.sourceMessageId ||
      native.toolExecutionPolicy?.mode !== 'plugin_native' ||
      native.toolExecutionPolicy.pluginInstanceId !== instanceId)
  )
    refuse();
  const checkAuthority = async () => {
    await current();
    if (!isDeepStrictEqual(binding, await services.readAuthority(input))) refuse();
    await current();
  };
  const messages = services.messageStore,
    key = pluginTaskDispatchKey(binding),
    content = pluginTaskDispatchContent(binding);
  await checkAuthority();
  const { message } = await messages.appendIdempotent({
    userId,
    threadId: binding.threadId,
    catId: null,
    content,
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: key,
  });
  const id = message.id;
  const validateTrigger = (message: StoredMessage | null): StoredMessage => {
    const live = structuredClone(message);
    if (
      !live ||
      live.id !== id ||
      live.userId !== userId ||
      live.threadId !== binding.threadId ||
      live.catId !== null ||
      live.source ||
      live.deletedAt ||
      live._tombstone ||
      live.recall ||
      live.sourceParseFailure ||
      live.content !== content
    )
      refuse();
    const c = live.queueCustody;
    if (c) {
      if (live.deliveryStatus === 'delivered' && c.status === 'terminal') assertQueuedMessageCustody(c);
      else assertQueueCustodyMessageBinding(live);
      if (
        c.sourceCategory !== 'plugin_task' ||
        c.ownerUserId !== userId ||
        c.ownerAuthProvenance !== 'unknown' ||
        c.intent !== 'execute' ||
        !isDeepStrictEqual(c.allTargetCats, [binding.targetCatId]) ||
        c.pluginPublicInvocation ||
        c.carrierByTargetCatId !== undefined ||
        c.carrierStateByTargetCatId !== undefined
      )
        refuse();
    } else if (live.deliveryStatus !== undefined && live.deliveryStatus !== 'queued') refuse();
    return live;
  };
  const checkIndex = async () => {
    if ((await messages.getByIdempotencyKey(userId, binding.threadId, key))?.id !== id) refuse();
  };
  const check = async (): Promise<StoredMessage> => {
    await checkAuthority();
    await checkIndex();
    await checkAuthority();
    return validateTrigger(await messages.getById(id));
  };
  let live = await check();
  if (!live.queueCustody) {
    const prepared = await messages.prepareQueueAdmission(id);
    if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') refuse();
    live = await check();
    const entry: QueueEntry = {
      id: randomUUID(),
      threadId: binding.threadId,
      userId,
      ownerAuthProvenance: 'unknown',
      messageId: id,
      content,
      mergedMessageIds: [],
      source: 'connector',
      sourceCategory: 'plugin_task',
      targetCats: [binding.targetCatId],
      allTargetCats: [binding.targetCatId],
      intent: 'execute',
      status: 'queued',
      createdAt: Date.now(),
      priority: 'normal',
      autoExecute: true,
    };
    const result = await messages.initializeQueueCustody(id, createInitialQueuedMessageCustody(entry));
    if (result.kind !== 'initialized' && result.kind !== 'existing') refuse();
    live = await check();
  }
  await checkAuthority();
  await checkIndex();
  // Read canonical custody after all yielding fences. Keep validation, selection
  // and restore synchronous so a cached queued state cannot resurrect a started Task.
  live = validateTrigger(await messages.getById(id));
  const custody = live.queueCustody;
  if (!custody) refuse();
  if (
    custody.status === 'queued' &&
    !custody.prestartRetirement &&
    Object.keys(custody.awakenedInvocationIdByCatId ?? {}).length === 0
  ) {
    // The shared startup parser rejects attempts that have already started or mixed lanes.
    const entry = buildQueueEntry([live], custody.entryId);
    services.queue.restoreDurableEntry(entry);
    await services.resume(binding.threadId, userId);
  }
  live = await check();
  if (!live.queueCustody) refuse();
  return Object.freeze({
    messageRef: `message:${id}`,
    entryId: live.queueCustody.entryId,
    status: live.queueCustody.status,
  });
}
