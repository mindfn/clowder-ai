import type { CatId } from '@cat-cafe/shared';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { ownedThreadFromSeed } from '../../cats/services/stores/ports/OwnedThreadSeed.js';
import type { Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { readPluginContinuationTask } from './plugin-task-continuation.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';

function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Derived Task execution thread is unavailable');
}

/** Source relations choose the private execution site; the package supplies no destination address. */
export async function resolvePluginTaskExecutionThread(
  deps: PluginTaskHostDeps,
  source: StoredMessage,
  parent: Thread,
  catId: string,
  assertCurrent: () => Promise<void>,
): Promise<string> {
  const tasks = deps.taskStore;
  const threads = deps.readThreadStore;
  if (!tasks || !threads || !deps.pluginInstanceId || !deps.ownerUserId) refuse();
  await assertCurrent();
  const matches = (await tasks.listByKind('work')).filter(
    (task) =>
      task.userId === deps.ownerUserId &&
      task.ownerCatId === catId &&
      task.entrustedWork?.admission.sourceRefs.includes(`message:${source.id}`),
  );
  await assertCurrent();
  if (matches.length > 1) refuse();
  const existing = matches[0];
  if (existing?.entrustedWork) {
    const canonical = await readPluginContinuationTask(
      deps,
      { kind: 'continue', taskRef: `task:work:${existing.id}`, expectedRevision: existing.entrustedWork.revision },
      catId,
    );
    await assertCurrent();
    return canonical.threadId;
  }
  if (!threads.ensureOwnedThread) refuse();
  const seed = {
    userId: deps.ownerUserId,
    idempotencyKey: `plugin-task:${deps.pluginInstanceId}:${source.id}:${catId}`,
    title: source.content.slice(0, 160),
    participants: [catId as CatId],
    projectPath: parent.projectPath,
    parentThreadId: source.threadId,
  };
  await assertCurrent();
  const created = await threads.ensureOwnedThread(seed);
  await assertCurrent();
  const thread = await threads.get(created.id);
  await assertCurrent();
  if (
    !thread ||
    thread.id !== ownedThreadFromSeed(seed).id ||
    thread.id === source.threadId ||
    thread.createdBy !== deps.ownerUserId ||
    thread.deletedAt ||
    thread.parentThreadId !== source.threadId ||
    thread.projectPath !== parent.projectPath ||
    !thread.participants.includes(catId as CatId)
  )
    refuse();
  return thread.id;
}
