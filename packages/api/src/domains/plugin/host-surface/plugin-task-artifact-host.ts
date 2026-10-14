import { isDeepStrictEqual } from 'node:util';
import type { CatId, RichBlock } from '@cat-cafe/shared';
import { z } from 'zod';
import { capturePluginTaskInvocationAuth } from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import { isDurableOwnerReadEvidence } from '../../cats/services/stores/visibility.js';
import { currentPluginCallContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import {
  parseTaskTextRef,
  readTaskTextFile,
  TASK_TEXT_BUDGET,
  taskTextDigest,
  taskTextFileName,
  writeTaskTextFile,
} from './plugin-task-artifact-file.js';

const textInput = z
  .object({ text: z.string().min(1).max(TASK_TEXT_BUDGET), mediaType: z.enum(['text/markdown', 'text/plain']) })
  .strict();
const selection = z
  .object({ publicationRef: z.string().regex(/^message:\S{1,500}$/), artifactRef: z.string().max(256) })
  .strict();
export interface TaskArtifactSelection {
  readonly publicationRef: string;
  /** Host-internal task-artifact ref; never an HTTP URL or a media entitlement. */
  readonly artifactRef: string;
}
export interface TaskArtifactPublication extends TaskArtifactSelection {
  readonly seal: {
    readonly taskRef: string;
    readonly executionRef: string;
    readonly invocationId: string;
    readonly triggerMessageId: string;
    readonly publisherCatId: string;
    readonly publicationRevision: number;
    readonly contentDigest: string;
    readonly byteLength: number;
    readonly mediaType: 'text/markdown' | 'text/plain';
  };
}
export interface PluginTaskArtifactHost {
  publishText(input: {
    readonly text: string;
    readonly mediaType: 'text/markdown' | 'text/plain';
  }): Promise<TaskArtifactPublication>;
  readText(input: TaskArtifactSelection): Promise<TaskArtifactPublication & { readonly text: string }>;
}
export interface PluginTaskArtifactDeps {
  readonly pluginInstanceId: string;
  readonly ownerUserId: string | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'appendIdempotent'> | undefined;
  readonly taskStore: Pick<ITaskStore, 'get' | 'attachEntrustedWorkArtifactEvidence'> | undefined;
  readonly taskArtifactDirectory: string;
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Task artifact unavailable to this execution');
}
function publicationKey(fileName: string) {
  return `plugin-task-artifact:${fileName}`;
}
function publicationBody() {
  return 'Task text artifact';
}

/** Same-execution text only. A Task ref or seal is not Service acceptance or authority to read historical results. */
export function createPluginTaskArtifactHost(deps: PluginTaskArtifactDeps): PluginTaskArtifactHost {
  async function principal(write: boolean) {
    const native = currentPluginCallContext(deps.pluginInstanceId),
      messages = deps.messageStore,
      tasks = deps.taskStore;
    if (
      !native?.readTaskBinding ||
      !native.assertInvocationCurrent ||
      !messages ||
      !tasks ||
      native.userId !== deps.ownerUserId ||
      native.ownerAuthProvenance !== 'unknown'
    )
      refuse();
    const binding = capturePluginTaskInvocationAuth({
      ...native,
      ownerAuthProvenance: native.ownerAuthProvenance,
      catId: native.catId as CatId,
      pluginTaskBinding: await native.readTaskBinding(),
    }).pluginTaskBinding;
    if (!binding || binding.version !== 2 || binding.pluginInstanceId !== deps.pluginInstanceId) refuse();
    const readTaskBinding = native.readTaskBinding.bind(native);
    const assertInvocationCurrent = native.assertInvocationCurrent.bind(native);
    const authorityRevision = binding.executionAuthorityRevision;
    if (authorityRevision === undefined) refuse();
    const current = async () => {
      await native.assertCurrent();
      await deps.assertCurrent(
        write ? ['task.read', 'task.write', 'thread.readContent', 'thread.write'] : ['task.read', 'thread.readContent'],
      );
      if (!isDeepStrictEqual(binding, await readTaskBinding())) refuse();
      await assertInvocationCurrent();
    };
    await current();
    return { native, binding, authorityRevision, messages, tasks, current };
  }
  type Caller = Awaited<ReturnType<typeof principal>>;
  async function task(caller: Caller, artifactRef?: string) {
    await caller.current();
    const t = structuredClone(await caller.tasks.get(caller.binding.taskId));
    await caller.current();
    const b = caller.binding,
      w = t?.entrustedWork;
    if (
      !t ||
      t.userId !== b.ownerUserId ||
      t.threadId !== b.threadId ||
      t.ownerCatId !== b.targetCatId ||
      t.kind !== 'work' ||
      t.status === 'done' ||
      !w ||
      w.closure.state !== 'open' ||
      w.executionAuthorityRevision !== b.executionAuthorityRevision ||
      w.admission.basis !== 'authorized_source' ||
      w.admission.authorityRef !== b.admissionRef ||
      (artifactRef !== undefined && !w.artifactRefs.includes(artifactRef))
    )
      refuse();
    return { ...t, entrustedWork: w };
  }
  async function readPublication(caller: Caller, input: TaskArtifactSelection, attached: boolean) {
    const file = parseTaskTextRef(caller.binding, caller.native.invocationId, input.artifactRef);
    await task(caller, attached ? input.artifactRef : undefined);
    const message = structuredClone(await caller.messages.getById(input.publicationRef.slice(8)));
    await caller.current();
    const expected: RichBlock = {
      id: 'task-text',
      kind: 'file',
      v: 1,
      url: input.artifactRef,
      fileName: file.fileName,
      mimeType: file.mediaType,
    };
    if (
      !message ||
      message.id !== input.publicationRef.slice(8) ||
      message.userId !== caller.binding.ownerUserId ||
      message.threadId !== caller.binding.threadId ||
      message.catId !== caller.binding.targetCatId ||
      message.origin !== 'callback' ||
      message.source ||
      message.sourceParseFailure ||
      message.recall ||
      message.deletedAt !== undefined ||
      message._tombstone ||
      message.deliveryStatus !== undefined ||
      message.visibility !== undefined ||
      message.contentBlocks !== undefined ||
      !isDurableOwnerReadEvidence(message) ||
      message.content !== publicationBody() ||
      !isDeepStrictEqual(message.extra, {
        rich: { v: 1, blocks: [expected] },
        stream: { turnInvocationId: caller.native.invocationId },
        causal: { kind: 'invocation_reply', triggerMessageId: caller.binding.triggerMessageId },
      })
    )
      refuse();
    const indexed = await caller.messages.getByIdempotencyKey(
      message.userId,
      message.threadId,
      publicationKey(file.fileName),
    );
    await caller.current();
    if (indexed?.id !== message.id) refuse();
    const bytes = await readTaskTextFile(deps.taskArtifactDirectory, file.fileName, file.digest);
    await caller.current();
    return { message, file, bytes };
  }
  async function sealed(caller: Caller, input: TaskArtifactSelection, attached: boolean) {
    const before = await readPublication(caller, input, attached);
    const after = await readPublication(caller, input, attached);
    if (!isDeepStrictEqual(before, after)) refuse();
    await task(caller, attached ? input.artifactRef : undefined);
    return snapshotPluginProtocolData({
      ...input,
      seal: {
        taskRef: `task:work:${caller.binding.taskId}`,
        executionRef: caller.binding.executionRef,
        invocationId: caller.native.invocationId,
        triggerMessageId: caller.binding.triggerMessageId,
        publisherCatId: caller.binding.targetCatId,
        publicationRevision: after.message.timestamp,
        contentDigest: `sha256:${after.file.digest}`,
        byteLength: after.bytes.byteLength,
        mediaType: after.file.mediaType,
      },
      text: after.bytes.text,
    }) as TaskArtifactPublication & { text: string };
  }
  return Object.freeze({
    async publishText(raw: Parameters<PluginTaskArtifactHost['publishText']>[0]) {
      const input = textInput.parse(snapshotPluginProtocolData(raw));
      const bytes = Buffer.from(input.text, 'utf8');
      if (bytes.length > TASK_TEXT_BUDGET || bytes.toString('utf8') !== input.text || input.text.includes('\0'))
        refuse();
      const caller = await principal(true);
      await task(caller);
      const fileName = taskTextFileName(
          caller.binding,
          caller.native.invocationId,
          taskTextDigest(bytes),
          input.mediaType,
        ),
        artifactRef = `task-artifact:${fileName}`;
      await writeTaskTextFile(deps.taskArtifactDirectory, fileName, bytes);
      await caller.current();
      const { message } = await caller.messages.appendIdempotent({
        userId: caller.binding.ownerUserId,
        threadId: caller.binding.threadId,
        catId: caller.binding.targetCatId as CatId,
        content: publicationBody(),
        mentions: [],
        timestamp: Date.now(),
        origin: 'callback',
        idempotencyKey: publicationKey(fileName),
        extra: {
          rich: {
            v: 1,
            blocks: [{ id: 'task-text', kind: 'file', v: 1, url: artifactRef, fileName, mimeType: input.mediaType }],
          },
          stream: { turnInvocationId: caller.native.invocationId },
          causal: { kind: 'invocation_reply', triggerMessageId: caller.binding.triggerMessageId },
        },
      });
      await caller.current();
      const selected = { publicationRef: `message:${message.id}`, artifactRef };
      await sealed(caller, selected, false);
      const live = await task(caller);
      const result = await caller.tasks.attachEntrustedWorkArtifactEvidence(caller.binding.taskId, {
        expectedRevision: live.entrustedWork.revision,
        executionAuthorityRevision: caller.authorityRevision,
        ownerUserId: caller.binding.ownerUserId,
        ownerCatId: caller.binding.targetCatId,
        threadId: caller.binding.threadId,
        admissionRef: caller.binding.admissionRef,
        artifactRef,
      });
      await caller.current();
      if (result.kind !== 'attached' && result.kind !== 'already_attached') refuse();
      const { text: _text, ...publication } = await sealed(caller, selected, true);
      return snapshotPluginProtocolData(publication) as TaskArtifactPublication;
    },
    async readText(raw: TaskArtifactSelection) {
      const input = selection.parse(snapshotPluginProtocolData(raw));
      return sealed(await principal(false), input, true);
    },
  });
}
