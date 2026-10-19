import type { TypedWaitSource } from '../domains/ball-custody/TypedWaitRegistration.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isOwnerVisibleManagedHoldConnector } from '../domains/cats/services/stores/visibility.js';

interface WaitSourceDeps {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly invocationTracker?: Pick<InvocationTracker, 'getActiveSlots'>;
}

function captureActiveInputIds(auth: InvocationRecord, deps: WaitSourceDeps): readonly string[] | undefined {
  const activeRun = deps.invocationTracker
    ?.getActiveSlots(auth.threadId)
    .find((slot) => slot.catId === auth.catId && slot.activeRun?.invocationId === auth.invocationId)?.activeRun;
  if (!activeRun || activeRun.threadId !== auth.threadId || activeRun.targetId !== auth.catId) return undefined;
  return [...activeRun.inputMessageIds];
}

/**
 * Deployment waits belong to the original work Task. Bind their continuation
 * to this invocation's primary input, independently of adopted command wakes.
 * A managed primary grants authority only over its own exact hold/source pair.
 */
export async function captureDeploymentWaitSource(
  auth: InvocationRecord,
  deps: WaitSourceDeps,
): Promise<TypedWaitSource | undefined> {
  try {
    const inputMessageIds = captureActiveInputIds(auth, deps);
    const sourceMessageId = auth.originTriggerMessageId;
    if (!sourceMessageId || !inputMessageIds?.includes(sourceMessageId)) return undefined;
    const origin = await deps.messageStore.getById(sourceMessageId);
    if (
      !origin ||
      origin.threadId !== auth.threadId ||
      origin.userId !== auth.userId ||
      origin.deletedAt !== undefined ||
      origin._tombstone
    ) {
      return undefined;
    }
    if (origin.source?.connector === 'hold-ball') {
      const holdTaskId = origin.source.meta?.taskId;
      if (
        !isOwnerVisibleManagedHoldConnector(origin, auth.userId) ||
        origin.source.meta?.catId !== auth.catId ||
        typeof holdTaskId !== 'string' ||
        holdTaskId.length === 0
      ) {
        return undefined;
      }
      return { kind: 'primary', sourceMessageId, holdTaskId };
    }
    return { kind: 'primary', sourceMessageId };
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the exact lifecycle inputs at callback entry. Later queue adoption
 * must not retrospectively grant a wait registration authority over a source
 * that was not part of this callback's initial view.
 */
export async function captureTypedWaitSource(
  auth: InvocationRecord,
  deps: WaitSourceDeps,
): Promise<TypedWaitSource | undefined> {
  try {
    const inputMessageIds = captureActiveInputIds(auth, deps);
    if (!inputMessageIds) return undefined;
    const managedHoldSources: Extract<TypedWaitSource, { holdTaskId?: string }>[] = [];
    for (const sourceMessageId of inputMessageIds) {
      const source = await deps.messageStore.getById(sourceMessageId);
      // A visible managed source can belong to a different thread; visibility is not authority.
      if (source && source.threadId !== auth.threadId) return undefined;
      const taskId = source?.source?.meta?.taskId;
      if (
        !source ||
        !isOwnerVisibleManagedHoldConnector(source, auth.userId) ||
        source.source?.meta?.catId !== auth.catId ||
        typeof taskId !== 'string' ||
        taskId.length === 0
      ) {
        continue;
      }
      managedHoldSources.push({
        kind: sourceMessageId === auth.originTriggerMessageId ? 'primary' : 'adopted_hold',
        sourceMessageId,
        holdTaskId: taskId,
      });
    }
    if (managedHoldSources.length > 1) return undefined;
    if (managedHoldSources[0]) return managedHoldSources[0];

    if (!auth.originTriggerMessageId || !inputMessageIds.includes(auth.originTriggerMessageId)) return undefined;
    const origin = await deps.messageStore.getById(auth.originTriggerMessageId);
    if (
      !origin ||
      origin.threadId !== auth.threadId ||
      origin.userId !== auth.userId ||
      origin.source?.connector === 'hold-ball' ||
      origin.deletedAt !== undefined ||
      origin._tombstone
    ) {
      return undefined;
    }
    return { kind: 'primary', sourceMessageId: origin.id };
  } catch {
    // The public tracking task remains useful without private continuation authority.
    return undefined;
  }
}
