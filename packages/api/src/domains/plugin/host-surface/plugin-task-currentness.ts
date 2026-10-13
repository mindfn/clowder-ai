import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import {
  capturePluginTaskInvocationAuth,
  type PluginTaskCurrentnessInput,
} from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../../cats/services/stores/ports/queued-message-custody.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { readPluginContinuationTask } from './plugin-task-continuation.js';
import {
  pluginTaskContinuationContent,
  pluginTaskContinuationKey,
  pluginTaskDispatchContent,
  pluginTaskDispatchKey,
  pluginTaskReceiptModes,
} from './plugin-task-receipt.js';

interface PluginTaskCurrentnessDeps {
  readonly ownerUserId: string;
  readonly taskStore: ITaskStore;
  readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
  readonly threadStore: Pick<IThreadStore, 'get'>;
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  isCatAvailable(catId: string): boolean;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Host Task execution authority is no longer current');
}
function liveMessage(message: StoredMessage | null, id: string, userId: string): StoredMessage {
  if (
    !message ||
    message.id !== id ||
    message.userId !== userId ||
    message.catId !== null ||
    message.deletedAt ||
    message._tombstone ||
    message.recall ||
    message.sourceParseFailure
  )
    refuse();
  return message;
}

async function readOwnedThread(deps: PluginTaskCurrentnessDeps, id: string, targetCatId?: string) {
  const thread = structuredClone(await deps.threadStore.get(id));
  if (
    !thread ||
    thread.id !== id ||
    thread.createdBy !== deps.ownerUserId ||
    thread.deletedAt ||
    (targetCatId !== undefined && !thread.participants.includes(targetCatId as CatId))
  )
    refuse();
  return thread;
}

function assertTaskDispatchCustody(trigger: StoredMessage, input: PluginTaskCurrentnessInput): string {
  assertQueueCustodyMessageBinding(trigger);
  const b = input.pluginTaskBinding;
  const custody = trigger.queueCustody;
  if (
    !custody ||
    custody.pluginPublicInvocation ||
    custody.ownerUserId !== b.ownerUserId ||
    custody.ownerAuthProvenance !== 'unknown' ||
    custody.status !== 'processing' ||
    custody.intent !== 'execute' ||
    custody.carrierByTargetCatId !== undefined ||
    !isDeepStrictEqual(custody.allTargetCats, [b.targetCatId]) ||
    !custody.pendingTargetCats.includes(b.targetCatId as CatId) ||
    custody.awakenedInvocationIdByCatId?.[b.targetCatId] !== input.invocationId ||
    custody.handledByCatIds.includes(b.targetCatId as CatId) ||
    custody.failedByCatIds.includes(b.targetCatId as CatId) ||
    custody.withdrawnByCatIds?.includes(b.targetCatId as CatId) ||
    custody.steerRequestedByCatIds?.includes(b.targetCatId as CatId) ||
    custody.steeredInvocationIdByCatId?.[b.targetCatId] ||
    custody.prestartRetirement
  )
    refuse();
  return custody.entryId;
}

/** Read-only Host authority, independent of package claims and callback credentials. */
export function createPluginTaskInvocationCurrentness(deps: PluginTaskCurrentnessDeps) {
  return async (raw: PluginTaskCurrentnessInput): Promise<void> => {
    // Revalidate at this boundary too; only the Registry supplies invocation identity.
    const input = capturePluginTaskInvocationAuth(raw),
      b = input.pluginTaskBinding;
    if (!b || input.userId !== deps.ownerUserId || !input.invocationId) refuse();
    const installation = async () => {
      const state = structuredClone(await deps.inventory.snapshot());
      const instance = state.instances.find((i) => i.pluginInstanceId === b.pluginInstanceId);
      const grants = state.grants.find((g) => g.pluginInstanceId === b.pluginInstanceId);
      const pkg = state.packages.find((p) => p.packageDigest === b.packageDigest);
      if (
        !instance ||
        instance.lifecycleState !== 'installed' ||
        instance.activationState !== 'enabled' ||
        instance.configReadiness !== 'ready' ||
        instance.runtimeState !== 'healthy' ||
        instance.packageDigest !== b.packageDigest ||
        instance.lifecycleRevision !== b.lifecycleRevision ||
        pkg?.packageState !== 'installed' ||
        pkg.pluginId !== instance.pluginId ||
        grants?.grantRevision !== b.grantRevision ||
        !grants.effectiveGrants.some((g: string) => g === 'task.admitEntrusted') ||
        !deps.isCatAvailable(b.targetCatId)
      )
        refuse();
    };
    const read = async () => {
      await installation();
      const task = await readPluginContinuationTask(
        {
          taskStore: deps.taskStore,
          readThreadStore: deps.threadStore,
          ownerUserId: deps.ownerUserId,
          pluginInstanceId: b.pluginInstanceId,
          admission: { messageStore: deps.messageStore },
        },
        { kind: 'continue', taskRef: `task:work:${b.taskId}`, expectedRevision: b.taskRevision },
        b.targetCatId,
      );
      const admission = task.entrustedWork?.admission;
      if (
        task.threadId !== b.threadId ||
        admission?.basis !== 'authorized_source' ||
        admission.authorityRef !== b.admissionRef
      )
        refuse();
      const source = liveMessage(
        structuredClone(await deps.messageStore.getById(b.sourceMessageId)),
        b.sourceMessageId,
        b.ownerUserId,
      );
      if (
        !source.source ||
        source.extra?.pluginMessage?.instanceId !== b.pluginInstanceId ||
        source.extra.pluginMessage.revision !== b.sourceRevision ||
        admission.sourceRefs.includes(`message:${source.id}`)
      )
        refuse();
      const sourceThread = await readOwnedThread(deps, source.threadId);
      const taskThread = await readOwnedThread(deps, b.threadId, b.targetCatId);
      const execution = liveMessage(
        structuredClone(await deps.messageStore.getById(b.executionRef.slice(8))),
        b.executionRef.slice(8),
        b.ownerUserId,
      );
      const receiptData = {
        kind: 'plugin_task_continuation' as const,
        version: 1 as const,
        pluginInstanceId: b.pluginInstanceId,
        userId: b.ownerUserId,
        source: {
          id: source.id,
          threadId: source.threadId,
          revision: b.sourceRevision,
          contentDigest: createHash('sha256').update(source.content).digest('hex'),
        },
        targetCatId: b.targetCatId,
        taskId: b.taskId,
        taskRevision: b.taskRevision,
        threadId: b.threadId,
        admissionRef: b.admissionRef,
      };
      if (
        execution.source ||
        execution.threadId !== source.threadId ||
        !pluginTaskReceiptModes.some(
          (mode) => execution.content === pluginTaskContinuationContent(receiptData, mode),
        ) ||
        (
          await deps.messageStore.getByIdempotencyKey(
            b.ownerUserId,
            source.threadId,
            pluginTaskContinuationKey(b.pluginInstanceId, source.id, b.targetCatId),
          )
        )?.id !== execution.id
      )
        refuse();
      const trigger = liveMessage(
        structuredClone(await deps.messageStore.getById(b.triggerMessageId)),
        b.triggerMessageId,
        b.ownerUserId,
      );
      if (
        trigger.source ||
        trigger.threadId !== b.threadId ||
        trigger.deliveryStatus !== 'queued' ||
        trigger.content !== pluginTaskDispatchContent(b) ||
        (await deps.messageStore.getByIdempotencyKey(b.ownerUserId, b.threadId, pluginTaskDispatchKey(b)))?.id !==
          trigger.id
      )
        refuse();
      const entryId = assertTaskDispatchCustody(trigger, input);
      await installation();
      // Do not freeze normal mutable Queue progress; its validity is checked on each read.
      return {
        task,
        source: {
          id: source.id,
          threadId: source.threadId,
          content: source.content,
          source: source.source,
          revision: b.sourceRevision,
        },
        sourceThread: { id: sourceThread.id, createdBy: sourceThread.createdBy },
        taskThread: { id: taskThread.id, createdBy: taskThread.createdBy, participants: taskThread.participants },
        execution: { id: execution.id, content: execution.content },
        trigger: { id: trigger.id, content: trigger.content, entryId },
      };
    };
    const before = await read();
    if (!isDeepStrictEqual(before, await read())) refuse();
    await installation();
    // Task was read before the source/receipt/Queue awaits. Fence those awaits
    // against the canonical Task again before returning to Registry verification.
    if (!isDeepStrictEqual(before.task, structuredClone(await deps.taskStore.get(b.taskId)))) refuse();
  };
}
