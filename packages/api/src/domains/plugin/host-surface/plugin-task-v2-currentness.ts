import { isDeepStrictEqual } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';
import type { PluginTaskExecutionBinding } from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { assertTaskProvenance, isOwnerTaskRequest, taskProvenanceMode } from './plugin-task-provenance.js';
import {
  parseTaskExecutionV2,
  pluginTaskExecutionContent,
  pluginTaskExecutionV2Key,
  taskAdmissionVersion,
  taskReceiptDigest,
} from './plugin-task-receipt.js';

function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Host Task v2 authority is no longer current');
}
/** Whole Task minus evidence-owned coordinates. Ordinary mutations still advance the pinned authority epoch. */
export function taskExecutionAuthorityProjection(task: TaskItem | null | undefined) {
  if (
    !task?.entrustedWork ||
    !Number.isSafeInteger(task.entrustedWork.executionAuthorityRevision) ||
    (task.entrustedWork.executionAuthorityRevision ?? 0) < 1
  )
    refuse();
  const { updatedAt: _updated, entrustedWork: _work, ...owner } = structuredClone(task);
  const { revision: _revision, artifactRefs: _artifacts, ...authority } = structuredClone(task.entrustedWork);
  return { ...owner, entrustedWork: authority };
}
export async function verifyTaskExecutionV2(
  binding: PluginTaskExecutionBinding,
  task: TaskItem,
  source: StoredMessage,
  execution: StoredMessage,
  messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>,
) {
  const b = binding,
    data = parseTaskExecutionV2(execution.content),
    work = task.entrustedWork;
  const firstReceipt = await messages.getById(b.admissionRef.slice(8));
  const first = taskAdmissionVersion(firstReceipt?.content ?? '');
  assertTaskProvenance(data.request, b.pluginInstanceId, b.ownerUserId, source.id);
  const initial = data.executionKind === 'initial',
    owner = isOwnerTaskRequest(data.request);
  if (
    first.version !== 2 ||
    !isDeepStrictEqual(first.provenance, data.firstAdmission) ||
    execution.source ||
    execution.threadId !== source.threadId ||
    taskReceiptDigest(execution.content) !== b.executionReceiptDigest ||
    data.pluginInstanceId !== b.pluginInstanceId ||
    data.userId !== b.ownerUserId ||
    data.taskId !== b.taskId ||
    data.taskRevision !== b.taskRevision ||
    data.threadId !== b.threadId ||
    data.targetCatId !== b.targetCatId ||
    data.admissionRef !== b.admissionRef ||
    data.executionAuthorityRevision !== b.executionAuthorityRevision ||
    work?.executionAuthorityRevision !== b.executionAuthorityRevision ||
    data.source.id !== source.id ||
    data.source.threadId !== source.threadId ||
    data.source.revision !== b.sourceRevision ||
    data.source.contentDigest !== taskReceiptDigest(source.content) ||
    data.mode !== taskProvenanceMode(data.request) ||
    (initial
      ? data.kind !== 'plugin_task_execution' ||
        !work.admission.sourceRefs.includes(`message:${source.id}`) ||
        !isDeepStrictEqual(data.request, data.firstAdmission)
      : data.kind !== 'plugin_task_continuation' ||
        (data.executionKind === 'owner_resume') !== owner ||
        (!owner && work.admission.sourceRefs.includes(`message:${source.id}`))) ||
    execution.content !== pluginTaskExecutionContent(data, data.mode) ||
    (await messages.getByIdempotencyKey(b.ownerUserId, source.threadId, pluginTaskExecutionV2Key(data)))?.id !==
      execution.id
  )
    refuse();
}
