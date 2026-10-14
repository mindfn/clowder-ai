import { isDeepStrictEqual } from 'node:util';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginTaskExecutionSnapshot } from './plugin-task-continuation.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import { isOwnerTaskRequest, type PluginTaskProvenance, taskProvenanceMode } from './plugin-task-provenance.js';
import {
  pluginTaskExecutionContent,
  pluginTaskExecutionV2Key,
  pluginTaskExecutionV2Schema,
  taskReceiptDigest,
} from './plugin-task-receipt.js';

function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}
/** Owner request identity selects an execution, never the Task or its authority epoch. */
export async function prepareTaskExecutionV2(
  deps: PluginTaskHostDeps,
  snapshot: PluginTaskExecutionSnapshot,
  firstAdmission: PluginTaskProvenance,
  caller: PluginTaskProvenance,
  kind: 'plugin_task_execution' | 'plugin_task_continuation',
  read: () => Promise<PluginTaskExecutionSnapshot>,
  current: () => Promise<void>,
) {
  const task = snapshot.task,
    work = task?.entrustedWork,
    messages = deps.admission?.messageStore;
  if (!task || !work || !messages || work.admission.basis !== 'authorized_source') refuse('Task execution unavailable');
  const initial = kind === 'plugin_task_execution';
  const isFirstSource = work.admission.sourceRefs.includes(`message:${snapshot.source.id}`);
  if (initial && !isFirstSource) refuse('Initial Task source changed');
  if (!initial && isFirstSource && !isOwnerTaskRequest(caller))
    refuse('First-source resume requires authenticated owner request');
  const request = initial ? firstAdmission : caller;
  const data = pluginTaskExecutionV2Schema.parse({
    kind,
    version: 2,
    pluginInstanceId: deps.pluginInstanceId,
    userId: deps.ownerUserId,
    source: {
      id: snapshot.source.id,
      threadId: snapshot.source.threadId,
      revision: snapshot.source.revision,
      contentDigest: taskReceiptDigest(snapshot.source.content),
    },
    targetCatId: task.ownerCatId,
    taskId: task.id,
    taskRevision: work.revision,
    threadId: task.threadId,
    admissionRef: work.admission.authorityRef,
    executionAuthorityRevision: work.executionAuthorityRevision,
    executionKind: initial ? 'initial' : isOwnerTaskRequest(caller) ? 'owner_resume' : 'source_continuation',
    firstAdmission,
    request,
    mode: taskProvenanceMode(request),
  });
  const key = pluginTaskExecutionV2Key(data),
    content = pluginTaskExecutionContent(data, data.mode);
  if (!isDeepStrictEqual(snapshot, await read())) refuse('Task execution changed before receipt persistence');
  await current();
  const { message } = await messages.appendIdempotent({
    userId: data.userId,
    threadId: data.source.threadId,
    catId: null,
    mentions: [],
    timestamp: Date.now(),
    content,
    idempotencyKey: key,
  });
  await current();
  if (
    message.source ||
    message.catId !== null ||
    message.userId !== data.userId ||
    message.threadId !== data.source.threadId ||
    message.deletedAt ||
    message._tombstone ||
    message.recall ||
    message.content !== content ||
    (await messages.getByIdempotencyKey(data.userId, data.source.threadId, key))?.id !== message.id
  )
    refuse('Host Task request receipt conflict');
  if (!isDeepStrictEqual(snapshot, await read())) refuse('Task execution changed during receipt persistence');
  await current();
  if (!isDeepStrictEqual(task, structuredClone(await deps.taskStore?.get(task.id))))
    refuse('Task changed after execution receipt persistence');
  return Object.freeze({
    taskRef: `task:work:${task.id}`,
    taskRevision: work.revision,
    threadId: task.threadId,
    admissionRef: data.admissionRef,
    executionRef: `message:${message.id}`,
  });
}
