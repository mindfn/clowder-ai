import {
  type PluginWaitState,
  type PluginWaitUpdate,
  type TaskItem,
  waitTerminationReasonSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStoreContract.js';
import type { PluginCallContext } from '../carrier/plugin-call-context.js';

const generation = z.number().int().positive().safe();
const identifier = z.string().min(1).max(500);
const updateSchema = z
  .object({
    expectedGeneration: generation.nullable(),
    generation,
    active: z.object({ expiresAt: z.number().int().positive().safe().optional() }).strict().nullable(),
    outcome: z
      .object({
        outcomeId: identifier,
        generation,
        ownerFence: z.object({ kind: z.literal('containing_task'), generation }).strict(),
        reason: waitTerminationReasonSchema,
        delivery: z.enum(['pending', 'delivered', 'not_applicable', 'legacy_unfenced']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.outcome &&
      (value.outcome.generation > value.generation ||
        (value.outcome.ownerFence.kind === 'containing_task' &&
          value.outcome.ownerFence.generation !== value.outcome.generation))
    ) {
      ctx.addIssue({ code: 'custom', message: 'outcome generation does not match the wait' });
    }
  });

export async function setPluginTaskWait(
  store: ITaskStore,
  instanceId: string | undefined,
  caller: PluginCallContext | undefined,
  taskId: string,
  input: PluginWaitUpdate,
): Promise<TaskItem | null> {
  if (!instanceId) throw new Error('Plugin instance is required');
  const value = updateSchema.parse(input);
  await caller?.assertCurrent();
  const task = await store.get(taskId);
  if (!task) return null;
  const old = task.pluginWait;
  if (!old && !caller) throw new Error('First wait registration requires an authenticated invocation');
  const owner = old ?? caller!;
  if (
    (old && old.pluginInstanceId !== instanceId) ||
    task.userId !== owner.userId ||
    task.ownerCatId !== owner.catId ||
    task.threadId !== owner.threadId ||
    (caller && (caller.userId !== owner.userId || caller.catId !== owner.catId || caller.threadId !== owner.threadId))
  ) {
    throw new Error('Wait belongs to another plugin, owner or thread');
  }
  if (old && old.generation === value.generation && !old.await && value.active) {
    throw new Error('A settled wait generation cannot be reactivated');
  }
  const registration =
    old?.generation === value.generation
      ? old.registration
      : caller?.source
        ? { invocationId: caller.invocationId, source: caller.source, registeredAt: Date.now() }
        : undefined;
  const state: PluginWaitState = {
    pluginInstanceId: instanceId,
    generation: value.generation,
    userId: owner.userId,
    catId: owner.catId,
    threadId: owner.threadId,
    ...(value.active ? { await: { generation: value.generation, ...value.active } } : {}),
    ...(value.outcome ? { waitOutcome: value.outcome } : {}),
    ...(registration ? { registration } : {}),
  };
  await caller?.assertCurrent();
  return store.replacePluginWait(taskId, { expectedGeneration: value.expectedGeneration, expectedState: old, state });
}
