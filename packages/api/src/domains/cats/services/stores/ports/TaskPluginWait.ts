import { isDeepStrictEqual } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';
import type { ReplacePluginWaitInput } from './TaskStoreContract.js';

/** Applied to the same Task snapshot used by the memory/Redis commit. */
export function replaceTaskPluginWait(task: TaskItem, input: ReplacePluginWaitInput): TaskItem | null {
  const { state, expectedGeneration } = input;
  const old = task.pluginWait;
  if (!isDeepStrictEqual(old, input.expectedState)) return null;
  const terminalTrackingRepair = (task.kind === 'pr_tracking' || task.kind === 'issue_tracking') && !!state.waitOutcome;
  if (
    task.entrustedWork ||
    (task.status === 'done' && (state.await || (!old && !terminalTrackingRepair))) ||
    task.userId !== state.userId ||
    task.ownerCatId !== state.catId ||
    task.threadId !== state.threadId ||
    (old && old.pluginInstanceId !== state.pluginInstanceId) ||
    (old?.generation ?? null) !== expectedGeneration ||
    state.generation < (old?.generation ?? 0)
  )
    return null;
  return { ...task, pluginWait: structuredClone(state), updatedAt: Math.max(Date.now(), task.updatedAt + 1) };
}
