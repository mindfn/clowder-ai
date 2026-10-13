import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import {
  type PluginTaskContinuationReceiptData,
  pluginTaskAdmissionContent,
  pluginTaskAdmissionKey,
  pluginTaskContinuationContent,
  pluginTaskContinuationKey,
  pluginTaskReceiptModes,
} from './plugin-task-receipt.js';

export interface PluginTaskContinuationSelector {
  readonly kind: 'continue';
  readonly taskRef: string;
  readonly expectedRevision: number;
}
function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}

type PluginTaskContinuationReadDeps = Pick<
  PluginTaskHostDeps,
  'taskStore' | 'readThreadStore' | 'ownerUserId' | 'pluginInstanceId'
> & {
  readonly admission?: { readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'> };
};

/** Re-read the canonical Task and the protected first receipt; selectors are not authority. */
export async function readPluginContinuationTask(
  deps: PluginTaskContinuationReadDeps,
  selector: PluginTaskContinuationSelector,
  catId: string,
) {
  const tasks = deps.taskStore,
    messages = deps.admission?.messageStore,
    threads = deps.readThreadStore,
    userId = deps.ownerUserId,
    instanceId = deps.pluginInstanceId;
  if (!tasks || !messages || !threads || !userId || !instanceId) refuse('Task continuation services unavailable');
  const task = structuredClone(await tasks.get(selector.taskRef.slice('task:work:'.length)));
  const work = task?.entrustedWork;
  if (
    !task ||
    task.id !== selector.taskRef.slice('task:work:'.length) ||
    task.kind !== 'work' ||
    task.userId !== deps.ownerUserId ||
    task.ownerCatId !== catId ||
    task.status === 'done' ||
    !work ||
    work.closure.state !== 'open' ||
    work.revision !== selector.expectedRevision ||
    work.admission.basis !== 'authorized_source' ||
    work.admission.sourceRefs.length !== 1 ||
    !work.admission.sourceRefs[0]?.startsWith('message:') ||
    !work.admission.authorityRef?.startsWith('message:')
  )
    refuse('Task continuation has no current owned admission');
  const firstSourceRef = work.admission.sourceRefs[0];
  const key = pluginTaskAdmissionKey(deps.pluginInstanceId, firstSourceRef, catId);
  const subjectKey = `entrusted:${createHash('sha256').update(key).digest('hex')}`;
  if (
    task.subjectKey !== subjectKey ||
    work.admission.idempotencyKey !== key ||
    (await tasks.getBySubject(subjectKey))?.id !== task.id
  )
    refuse('Task was not admitted by this installation');
  const source = structuredClone(await messages.getById(firstSourceRef.slice(8)));
  if (
    !source ||
    source.id !== firstSourceRef.slice(8) ||
    source.userId !== deps.ownerUserId ||
    source.catId !== null ||
    source.deletedAt ||
    source._tombstone ||
    source.recall ||
    source.sourceParseFailure ||
    !source.source ||
    source.extra?.pluginMessage?.instanceId !== deps.pluginInstanceId ||
    !Number.isSafeInteger(source.extra.pluginMessage.revision)
  )
    refuse('Task first source is unavailable');
  const thread = structuredClone(await threads.get(source.threadId));
  if (!thread || thread.createdBy !== deps.ownerUserId || thread.deletedAt)
    refuse('Task first source thread is unavailable');
  const receipt = structuredClone(await messages.getById(work.admission.authorityRef.slice(8)));
  const sourceRevision = source.extra.pluginMessage.revision;
  const expected = (mode: string) =>
    pluginTaskAdmissionContent(
      {
        kind: 'plugin_task_admission',
        version: 1,
        pluginInstanceId: instanceId,
        userId,
        source: {
          id: source.id,
          threadId: source.threadId,
          revision: sourceRevision,
          contentDigest: createHash('sha256').update(source.content).digest('hex'),
        },
        targetCatId: catId,
        threadId: task.threadId,
        subject: { title: task.title, intendedOutcome: work.intendedOutcome },
      },
      mode,
    );
  if (
    !receipt ||
    `message:${receipt.id}` !== work.admission.authorityRef ||
    receipt.source ||
    receipt.catId !== null ||
    receipt.userId !== deps.ownerUserId ||
    receipt.threadId !== source.threadId ||
    receipt.deletedAt ||
    receipt._tombstone ||
    receipt.recall ||
    !pluginTaskReceiptModes.some((mode) => receipt.content === expected(mode)) ||
    (await messages.getByIdempotencyKey(deps.ownerUserId, source.threadId, key))?.id !== receipt.id
  )
    refuse('Task first admission receipt is unavailable or changed');
  return task;
}

export interface PluginContinuationSnapshot {
  readonly source: {
    readonly id: string;
    readonly threadId: string;
    readonly content: string;
    readonly revision: number;
  };
  readonly threadId: string;
  readonly continuation?: TaskItem;
}
/** Preserve the immutable first admission, writing only an execution receipt. No queue or provider effect. */
export async function preparePluginTaskContinuation(
  deps: PluginTaskHostDeps,
  snapshot: PluginContinuationSnapshot,
  mode: string,
  read: () => Promise<PluginContinuationSnapshot>,
  current: () => Promise<void>,
) {
  const task = snapshot.continuation;
  const messages = deps.admission?.messageStore;
  const admission = task?.entrustedWork?.admission;
  if (admission?.basis !== 'authorized_source') refuse('Task continuation lacks authorized-source admission');
  const admissionRef = admission.authorityRef;
  if (!task?.entrustedWork || !admissionRef || !messages || !deps.ownerUserId || !deps.pluginInstanceId)
    refuse('Task continuation unavailable');
  if (task.entrustedWork.admission.sourceRefs.includes(`message:${snapshot.source.id}`))
    refuse('Continuation requires a new durable source');
  const data: PluginTaskContinuationReceiptData = {
    kind: 'plugin_task_continuation',
    version: 1,
    pluginInstanceId: deps.pluginInstanceId,
    userId: deps.ownerUserId,
    source: {
      id: snapshot.source.id,
      threadId: snapshot.source.threadId,
      revision: snapshot.source.revision,
      contentDigest: createHash('sha256').update(snapshot.source.content).digest('hex'),
    },
    targetCatId: task.ownerCatId,
    taskId: task.id,
    taskRevision: task.entrustedWork.revision,
    threadId: task.threadId,
    admissionRef,
  };
  const content = (origin: string) => pluginTaskContinuationContent(data, origin);
  const key = pluginTaskContinuationKey(deps.pluginInstanceId, snapshot.source.id, task.ownerCatId);
  if (!isDeepStrictEqual(snapshot, await read())) refuse('Task continuation changed before receipt persistence');
  await current();
  const { message } = await messages.appendIdempotent({
    userId: deps.ownerUserId,
    threadId: snapshot.source.threadId,
    catId: null,
    mentions: [],
    timestamp: Date.now(),
    content: content(mode),
    idempotencyKey: key,
  });
  await current();
  if (
    message.source ||
    message.catId !== null ||
    message.userId !== deps.ownerUserId ||
    message.threadId !== snapshot.source.threadId ||
    message.deletedAt ||
    message._tombstone ||
    message.recall ||
    !pluginTaskReceiptModes.some((origin) => message.content === content(origin)) ||
    (await messages.getByIdempotencyKey(deps.ownerUserId, snapshot.source.threadId, key))?.id !== message.id
  )
    refuse('Task continuation receipt conflicts with the existing source request');
  if (!isDeepStrictEqual(snapshot, await read())) refuse('Task continuation changed during receipt persistence');
  await current();
  return Object.freeze({
    result: 'resumed' as const,
    taskRef: `task:work:${task.id}`,
    taskRevision: task.entrustedWork.revision,
    threadId: task.threadId,
    admissionRef,
    executionRef: `message:${message.id}`,
  });
}
