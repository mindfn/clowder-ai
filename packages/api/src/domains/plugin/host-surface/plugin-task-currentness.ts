import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  capturePluginTaskBinding,
  capturePluginTaskExecutionBinding,
  capturePluginTaskInvocationAuth,
  type PluginTaskCurrentnessInput,
  type PluginTaskExecutionBinding,
  type PluginTaskInvocationBinding,
} from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../../cats/services/stores/ports/queued-message-custody.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { readPluginContinuationTask } from './plugin-task-continuation.js';
import {
  assertUnstartedTaskCustody,
  createTaskQueueAuthority,
  type PluginTaskAuthorityPhase,
} from './plugin-task-queue-authority.js';
import {
  pluginTaskDispatchContent,
  pluginTaskDispatchKey,
  pluginTaskExecutionContent,
  pluginTaskExecutionKey,
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

function assertTaskDispatchCustody(
  trigger: StoredMessage,
  b: PluginTaskInvocationBinding,
  phase: PluginTaskAuthorityPhase,
): string {
  assertQueueCustodyMessageBinding(trigger);
  const custody = trigger.queueCustody;
  if (
    !custody ||
    custody.pluginPublicInvocation ||
    custody.ownerUserId !== b.ownerUserId ||
    custody.ownerAuthProvenance !== 'unknown' ||
    custody.intent !== 'execute' ||
    custody.carrierByTargetCatId !== undefined ||
    custody.carrierStateByTargetCatId !== undefined ||
    !isDeepStrictEqual(custody.allTargetCats, [b.targetCatId]) ||
    !custody.pendingTargetCats.includes(b.targetCatId as CatId) ||
    custody.handledByCatIds.includes(b.targetCatId as CatId) ||
    custody.failedByCatIds.includes(b.targetCatId as CatId) ||
    custody.withdrawnByCatIds?.includes(b.targetCatId as CatId) ||
    custody.steerRequestedByCatIds?.includes(b.targetCatId as CatId) ||
    custody.steeredInvocationIdByCatId?.[b.targetCatId] ||
    custody.prestartRetirement
  )
    refuse();
  if (phase.kind === 'queue') {
    if (custody.entryId !== phase.entryId) refuse();
    assertUnstartedTaskCustody(custody, b.targetCatId);
  } else if (
    custody.status !== 'processing' ||
    custody.awakenedInvocationIdByCatId?.[b.targetCatId] !== phase.invocationId
  ) {
    refuse();
  }
  return custody.entryId;
}

/** Read-only Host authority, independent of package claims and callback credentials. */
export function createPluginTaskInvocationCurrentness(deps: PluginTaskCurrentnessDeps) {
  const read = createAuthorityReader(deps);
  return async (raw: PluginTaskCurrentnessInput): Promise<void> => {
    const input = capturePluginTaskInvocationAuth(raw);
    if (!input.pluginTaskBinding || input.userId !== deps.ownerUserId || !input.invocationId) refuse();
    await read(input.pluginTaskBinding, { kind: 'invocation', invocationId: input.invocationId });
  };
}

/** Host Queue selection and one-time child binding; not an SDK authorization surface. */
export function createPluginTaskQueueAuthority(
  deps: PluginTaskCurrentnessDeps & {
    messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'transitionQueueCustody'>;
  },
) {
  return createTaskQueueAuthority(deps.messageStore, deps.ownerUserId, createAuthorityReader(deps));
}

function createAuthorityReader(deps: PluginTaskCurrentnessDeps) {
  return async (
    raw: PluginTaskExecutionBinding,
    phase: PluginTaskAuthorityPhase | { readonly kind: 'dispatch' },
  ): Promise<void> => {
    const b = phase.kind === 'dispatch' ? capturePluginTaskExecutionBinding(raw) : capturePluginTaskBinding(raw);
    if (b.ownerUserId !== deps.ownerUserId) refuse();
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
        source.extra.pluginMessage.revision !== b.sourceRevision
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
        kind: admission.sourceRefs.includes(`message:${source.id}`)
          ? ('plugin_task_execution' as const)
          : ('plugin_task_continuation' as const),
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
        !pluginTaskReceiptModes.some((mode) => execution.content === pluginTaskExecutionContent(receiptData, mode)) ||
        (
          await deps.messageStore.getByIdempotencyKey(
            b.ownerUserId,
            source.threadId,
            pluginTaskExecutionKey(b.pluginInstanceId, source.id, b.targetCatId, receiptData.kind),
          )
        )?.id !== execution.id
      )
        refuse();
      const triggerSnapshot = await (async () => {
        if (phase.kind === 'dispatch') return undefined;
        const full = capturePluginTaskBinding(raw);
        const trigger = liveMessage(
          structuredClone(await deps.messageStore.getById(full.triggerMessageId)),
          full.triggerMessageId,
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
        const entryId = assertTaskDispatchCustody(trigger, full, phase);
        return {
          id: trigger.id,
          content: trigger.content,
          entryId,
          ...(phase.kind === 'queue' ? { custody: trigger.queueCustody } : {}),
        };
      })();
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
        trigger: triggerSnapshot,
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

const dispatchSelectionSchema = z
  .object({
    taskRef: z.string().regex(/^task:work:\S{1,500}$/u),
    taskRevision: z.number().int().positive(),
    executionRef: z.string().regex(/^message:\S{1,500}$/u),
  })
  .strict();
export type PluginTaskDispatchSelection = z.infer<typeof dispatchSelectionSchema>;
export function capturePluginTaskDispatchSelection(raw: unknown): PluginTaskDispatchSelection {
  return dispatchSelectionSchema.parse(snapshotPluginProtocolData(raw));
}
const receiptCoordinatesSchema = z.object({
  source: z.object({ id: z.string(), revision: z.number() }),
  targetCatId: z.string(),
  threadId: z.string(),
  admissionRef: z.string(),
});
/** Derive coordinates from stored receipt data, then authenticate its exact body and protected index. */
export function createPluginTaskDispatchAuthority(deps: PluginTaskCurrentnessDeps, pluginInstanceId: string) {
  const authenticate = createAuthorityReader(deps);
  return Object.freeze({
    async read(raw: PluginTaskDispatchSelection): Promise<PluginTaskExecutionBinding> {
      const selected = capturePluginTaskDispatchSelection(raw);
      const execution = liveMessage(
        structuredClone(await deps.messageStore.getById(selected.executionRef.slice(8))),
        selected.executionRef.slice(8),
        deps.ownerUserId,
      );
      const data = receiptCoordinatesSchema.parse(
        JSON.parse(execution.content.slice(execution.content.indexOf('\n') + 1)),
      );
      const state = structuredClone(await deps.inventory.snapshot());
      const instance = state.instances.find((i) => i.pluginInstanceId === pluginInstanceId);
      const grant = state.grants.find((g) => g.pluginInstanceId === pluginInstanceId);
      const binding = capturePluginTaskExecutionBinding({
        version: 1,
        pluginInstanceId,
        ownerUserId: deps.ownerUserId,
        taskId: selected.taskRef.slice(10),
        taskRevision: selected.taskRevision,
        executionRef: selected.executionRef,
        targetCatId: data.targetCatId,
        threadId: data.threadId,
        admissionRef: data.admissionRef,
        sourceMessageId: data.source.id,
        sourceRevision: data.source.revision,
        packageDigest: instance?.packageDigest,
        lifecycleRevision: instance?.lifecycleRevision,
        grantRevision: grant?.grantRevision,
      });
      await authenticate(binding, { kind: 'dispatch' });
      return binding;
    },
  });
}
