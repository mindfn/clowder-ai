import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type CatId, type RegisteredCustodyGrantV1 } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import {
  EntrustedWorkLifecycleService,
  entrustedWorkAdmissionCommandV1Schema,
} from '../../growing/EntrustedWorkLifecycleService.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { currentOwnerOperation } from '../carrier/plugin-owner-operation-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { createPluginSourceFactsHost } from './plugin-source-facts-host.js';
import { preparePluginTaskContinuation, readPluginContinuationTask } from './plugin-task-continuation.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import {
  type PluginTaskReceiptData,
  pluginTaskAdmissionContent,
  pluginTaskAdmissionKey,
  pluginTaskReceiptModes,
} from './plugin-task-receipt.js';

const ref = z.string().trim().min(1).max(500);
const schema = z
  .object({
    sourceMessageId: ref,
    targetCatId: ref,
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('derived_from_source') }).strict(),
      z.object({ kind: z.literal('existing_thread'), threadId: ref }).strict(),
    ]),
    subject: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('new'),
          title: entrustedWorkAdmissionCommandV1Schema.shape.task.shape.title,
          intendedOutcome: z.string().trim().min(1).max(4_000),
          closure: entrustedWorkAdmissionCommandV1Schema.shape.closure,
          time: entrustedWorkAdmissionCommandV1Schema.shape.time,
        })
        .strict(),
      z
        .object({
          kind: z.literal('continue'),
          taskRef: ref.regex(/^task:work:.+/),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
    ]),
  })
  .strict();
export type PluginTaskAdmissionInput = z.infer<typeof schema>;
export type PluginTaskAdmissionResult =
  | { readonly result: 'needs_clarification'; readonly clarificationReason: string }
  | {
      readonly result: 'admitted' | 'resumed';
      readonly taskRef: string;
      readonly taskRevision: number;
      readonly threadId: string;
      readonly admissionRef: string;
      readonly executionRef?: string;
    };

/** Host-only stores and fences. This object never crosses the module boundary. */
export interface PluginTaskAdmissionServices {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'appendIdempotent'>;
  isCatAvailable(catId: string): boolean;
  /** The installation, package and grant revisions captured by this activation must still match. */
  assertCurrent(): Promise<void>;
}
export async function createPluginTaskAdmissionServices(deps: {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly inventory: PluginInventoryStore;
  readonly messageStore: PluginTaskAdmissionServices['messageStore'];
  readonly assertActivation: () => void;
  readonly isCatAvailable: (catId: string) => boolean;
}): Promise<PluginTaskAdmissionServices> {
  const initial = await deps.inventory.snapshot();
  const instance = initial.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId);
  const grant = initial.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId);
  if (!instance || !grant || instance.packageDigest !== deps.packageDigest) refuse('Task installation unavailable');
  const lifecycleRevision = instance.lifecycleRevision,
    grantRevision = grant.grantRevision;
  return Object.freeze({
    messageStore: deps.messageStore,
    isCatAvailable: deps.isCatAvailable,
    async assertCurrent() {
      deps.assertActivation();
      const snapshot = await deps.inventory.snapshot();
      deps.assertActivation();
      const live = snapshot.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId);
      const grants = snapshot.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId);
      const pkg = snapshot.packages.find((p) => p.packageDigest === deps.packageDigest);
      if (
        !live ||
        live.lifecycleState !== 'installed' ||
        live.activationState !== 'enabled' ||
        live.configReadiness !== 'ready' ||
        live.lifecycleRevision !== lifecycleRevision ||
        live.packageDigest !== deps.packageDigest ||
        pkg?.packageState !== 'installed' ||
        grants?.grantRevision !== grantRevision ||
        !grants.effectiveGrants.some((g: string) => g === 'task.admitEntrusted')
      )
        refuse('Task installation or admission capability is no longer current');
    },
  });
}
function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}

/** Only prepares the existing Task/Lifecycle effect. It does not start an agent. */
export async function preparePluginEntrustedTask(
  deps: PluginTaskHostDeps,
  raw: PluginTaskAdmissionInput,
): Promise<PluginTaskAdmissionResult> {
  const value = schema.parse(snapshotPluginProtocolData(raw));
  if (!deps.effectiveGrants.includes('task.admitEntrusted')) refuse('Plugin lacks task.admitEntrusted');
  const instanceId = deps.pluginInstanceId;
  const userId = deps.ownerUserId;
  const services = deps.admission;
  const tasks = deps.taskStore;
  const threads = deps.readThreadStore;
  if (!instanceId || !userId || !services || !tasks || !threads)
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host Task admission services unavailable');
  const messages = services.messageStore;
  const native = currentPluginCallContext(instanceId);
  const owner = currentPluginOwnerRequestContext(instanceId);
  const operation = currentOwnerOperation(instanceId);
  if ((owner && (owner.userId !== userId || owner.operation !== 'write')) || (operation && operation.userId !== userId))
    refuse('Task admission requires the authenticated installation owner write');
  if (
    native &&
    (native.userId !== userId ||
      native.catId !== value.targetCatId ||
      native.originTriggerMessageId !== value.sourceMessageId ||
      native.toolExecutionPolicy?.mode !== 'plugin_native' ||
      native.toolExecutionPolicy.pluginInstanceId !== instanceId)
  )
    refuse('Task admission native source does not match');
  const mode = owner || operation ? 'owner_request' : native ? 'native_request' : 'plugin_policy';
  if (value.destination.kind === 'existing_thread' && mode !== 'owner_request')
    refuse('Only an authenticated owner write may select the destination thread');
  const current = async () => {
    await deps.assertCurrent?.();
    await services.assertCurrent();
    await native?.assertCurrent();
    await owner?.assertCurrent();
    await operation?.assertCurrent();
    await services.assertCurrent();
    if (!services.isCatAvailable(value.targetCatId)) refuse('Task target is unavailable');
  };
  const nativeSource = createPluginSourceFactsHost({
    pluginInstanceId: instanceId,
    ownerUserId: userId,
    messageStore: messages,
    threadStore: threads,
    assertCurrent: async () => current(),
  }).nativeContext;
  const read = async () => {
    await current();
    if (native) await nativeSource.current();
    const continuation =
      value.subject.kind === 'continue'
        ? await readPluginContinuationTask(deps, value.subject, value.targetCatId)
        : undefined;
    await current();
    const source = structuredClone(await messages.getById(value.sourceMessageId));
    await current();
    if (
      !source ||
      source.id !== value.sourceMessageId ||
      source.userId !== userId ||
      source.catId !== null ||
      source.deletedAt ||
      source._tombstone ||
      source.recall ||
      source.sourceParseFailure ||
      !source.source ||
      !source.extra?.pluginMessage ||
      source.extra.pluginMessage.instanceId !== instanceId ||
      !Number.isSafeInteger(source.extra.pluginMessage.revision)
    )
      refuse('Task source is not a current source of this installation');
    const sourceThread = structuredClone(await threads.get(source.threadId));
    await current();
    if (!sourceThread || sourceThread.createdBy !== userId || sourceThread.deletedAt)
      refuse('Task source thread is unavailable');
    const threadId =
      continuation?.threadId ??
      (value.destination.kind === 'existing_thread' ? value.destination.threadId : source.threadId);
    if (
      continuation &&
      value.destination.kind === 'existing_thread' &&
      value.destination.threadId !== continuation.threadId
    )
      refuse('Continuation cannot move the admitted Task');
    const thread = structuredClone(await threads.get(threadId));
    await current();
    if (
      !thread ||
      thread.id !== threadId ||
      thread.createdBy !== userId ||
      thread.deletedAt ||
      !thread.participants.includes(value.targetCatId as CatId)
    )
      refuse('Task destination or participant is unavailable');
    return {
      source: {
        id: source.id,
        threadId: source.threadId,
        content: source.content,
        revision: source.extra.pluginMessage.revision,
      },
      threadId,
      ...(continuation ? { continuation } : {}),
    };
  };
  const source = await read();
  if (!isDeepStrictEqual(source, await read())) refuse('Task source changed during admission');
  if (value.subject.kind === 'continue') return preparePluginTaskContinuation(deps, source, mode, read, current);
  const sourceRef = `message:${source.source.id}`;
  const key = pluginTaskAdmissionKey(instanceId, sourceRef, value.targetCatId);
  const receiptData: PluginTaskReceiptData = {
    kind: 'plugin_task_admission',
    version: 1,
    pluginInstanceId: instanceId,
    userId,
    source: {
      id: source.source.id,
      threadId: source.source.threadId,
      revision: source.source.revision,
      contentDigest: createHash('sha256').update(source.source.content).digest('hex'),
    },
    targetCatId: value.targetCatId,
    threadId: source.threadId,
    // Closure/time may still require clarification. Lifecycle owns their durable
    // contract and replay compatibility; this receipt binds the immutable request.
    subject: { title: value.subject.title, intendedOutcome: value.subject.intendedOutcome },
  };
  const receiptContent = (origin: string) => pluginTaskAdmissionContent(receiptData, origin);
  await current();
  const appended = await messages.appendIdempotent({
    userId,
    threadId: source.source.threadId,
    catId: null,
    mentions: [],
    content: receiptContent(mode),
    timestamp: Date.now(),
    idempotencyKey: key,
  });
  const receipt = appended.message;
  await current();
  // The first durable receipt owns attribution, including clarification retries
  // made through a different currently authenticated entry point.
  const receiptMode = pluginTaskReceiptModes.find((origin) => receipt.content === receiptContent(origin));
  if (
    receiptMode === undefined ||
    receipt.source ||
    receipt.catId !== null ||
    receipt.userId !== userId ||
    receipt.threadId !== source.source.threadId ||
    receipt.deletedAt ||
    receipt._tombstone ||
    receipt.recall ||
    (await messages.getByIdempotencyKey(userId, source.source.threadId, key))?.id !== receipt.id
  )
    refuse('Task admission receipt conflicts with the existing source request');
  if (!isDeepStrictEqual(source, await read())) refuse('Task source changed before the Lifecycle effect');
  const admissionRef = `message:${receipt.id}`;
  // This registry entry represents this Host-accepted plugin request. It makes no
  // claim that Host independently authenticated the plugin's remote business grant.
  const grant: RegisteredCustodyGrantV1 = {
    grantRef: admissionRef,
    revision: 1,
    producerRef: `plugin-policy:${instanceId}`,
    grantOwnerRef: `user:${userId}`,
    grantOwnerRevision: receipt.id,
    allowedSourceScope: [sourceRef],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: null },
    idempotencySource: 'source_ref_and_revision',
  };
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { custodyGrantRegistry: { [admissionRef]: grant } });
  await current();
  const result = await lifecycle.admitOrResume(
    {
      task: {
        threadId: source.threadId,
        title: value.subject.title,
        why: value.subject.intendedOutcome.slice(0, 1_000),
        createdBy: receiptMode === 'owner_request' ? 'user' : 'system',
        ownerCatId: value.targetCatId as CatId,
        userId,
      },
      admission: {
        basis: 'authorized_source',
        sourceRefs: [sourceRef],
        intendedOutcome: value.subject.intendedOutcome,
        idempotencyKey: key,
        authorityProvenance: {
          grantRef: admissionRef,
          grantRevision: grant.revision,
          producerRef: grant.producerRef,
          grantOwnerRef: grant.grantOwnerRef,
          grantOwnerRevision: grant.grantOwnerRevision,
          sourceRef,
          sourceRevision: source.source.id,
          matchedScope: sourceRef,
          admissionAuthority: grant.admissionAuthority,
          idempotencySource: grant.idempotencySource,
        },
      },
      ...(value.subject.closure ? { closure: value.subject.closure } : {}),
      ...(value.subject.time ? { time: value.subject.time } : {}),
    },
    { sourceRef, content: source.source.content },
  );
  await current();
  if (!isDeepStrictEqual(source, await read())) refuse('Task source changed during the Lifecycle effect');
  if (result.result === 'needs_clarification') return Object.freeze(result);
  const task = await tasks.get(result.subjectRef.slice('task:work:'.length));
  await current();
  if (
    !task ||
    task.userId !== userId ||
    task.ownerCatId !== value.targetCatId ||
    task.threadId !== source.threadId ||
    task.entrustedWork?.admission.basis !== 'authorized_source' ||
    task.entrustedWork.admission.authorityRef !== admissionRef ||
    task.entrustedWork.closure.state !== 'open'
  )
    refuse('Task no longer matches the prepared admission');
  return Object.freeze({
    result: result.result,
    taskRef: result.subjectRef,
    taskRevision: task.entrustedWork.revision,
    threadId: task.threadId,
    admissionRef,
  });
}
