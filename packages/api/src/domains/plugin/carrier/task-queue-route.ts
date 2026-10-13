import { isDeepStrictEqual } from 'node:util';
import type { InvocationQueue, QueueEntry } from '../../cats/services/agents/invocation/InvocationQueue.js';
import { assertTaskQueueEntry } from '../../cats/services/agents/invocation/plugin-task-queue-state.js';
import type { PublicInvocationExecution } from '../../cats/services/agents/invocation/public-invocation-execution.js';
import type { RouteOptions } from '../../cats/services/agents/routing/route-helpers.js';
import type { createPluginTaskQueueAuthority } from '../host-surface/plugin-task-currentness.js';
import type { PluginRuntimeCarrierRouter } from './runtime-carrier.js';

/** A Queue selector never carries authority. Reconstruct it before registration, then bind that exact child. */
export function createTaskQueueRoute(
  queue: Pick<InvocationQueue, 'getEntrySnapshot' | 'restoreEntrySnapshotIfUnchanged'>,
  authority: () => ReturnType<typeof createPluginTaskQueueAuthority>,
  runtime: () => Pick<PluginRuntimeCarrierRouter, 'resolveTaskInvocationPolicy'>,
  execution: PublicInvocationExecution,
) {
  return Object.freeze({
    async resolve(
      raw: QueueEntry,
    ): Promise<
      | Pick<RouteOptions, 'pluginTaskBinding' | 'pluginTaskExecution' | 'toolExecutionPolicy'>
      | { readonly kind: 'stale_task_projection' }
    > {
      const entry = structuredClone(raw);
      assertTaskQueueEntry(entry);
      const messageId = entry.messageId;
      const targetCatId = entry.targetCats[0];
      if (!messageId || !targetCatId) throw new Error('task_queue_selector_missing');
      const selected = Object.freeze({
        messageId,
        entryId: entry.id,
        userId: entry.userId,
        threadId: entry.threadId,
        targetCatId,
      });
      const port = authority();
      if (await port.isStaleProjection(selected)) return { kind: 'stale_task_projection' };
      try {
        const binding = await port.read(selected);
        const check = async () => {
          if (!isDeepStrictEqual(await port.read(selected), binding)) throw new Error('task_queue_identity_changed');
        };
        const policy = await runtime().resolveTaskInvocationPolicy(binding, check);
        await check();
        return Object.freeze({
          pluginTaskBinding: binding,
          toolExecutionPolicy: policy,
          pluginTaskExecution: Object.freeze({
            async prepare(input: Parameters<PublicInvocationExecution['prepare']>[0]) {
              input.signal.throwIfAborted();
              if (input.sourceMessageId !== selected.messageId) throw new Error('task_queue_trigger_changed');
              const bound = await port.bindChild({ ...selected, binding, invocationId: input.invocationId });
              input.signal.throwIfAborted();
              const current = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
              if (
                !current ||
                current.status !== 'processing' ||
                !isDeepStrictEqual(
                  { ...current, status: 'queued', processingStartedAt: undefined },
                  { ...entry, status: 'queued', processingStartedAt: undefined },
                ) ||
                !queue.restoreEntrySnapshotIfUnchanged(current, {
                  ...current,
                  queuedAwakenedInvocationIdByCatId: { ...bound.custody.awakenedInvocationIdByCatId },
                  queuedAwakenedAtByCatId: { ...bound.custody.awakenedAtByCatId },
                })
              )
                throw new Error('task_queue_claim_lost');
              return execution.prepare(input);
            },
          }),
        });
      } catch (error) {
        // A competing child/settlement can win during authority or policy reads.
        // Only canonical projection obsolescence is cleanup, never a generic denial.
        if (await port.isStaleProjection(selected)) return { kind: 'stale_task_projection' };
        throw error;
      }
    },
  });
}
