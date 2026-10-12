import { join } from 'node:path';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import type { TaskSpec_P1 } from '../../../infrastructure/scheduler/types.js';
import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { PersistedQueueDeliveryPort } from '../../cats/services/agents/invocation/PersistedQueueDelivery.js';
import { CodexNativeImageEvidenceReader } from '../../cats/services/agents/providers/CodexNativeImageEvidenceReader.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { createArtifactReviewIntegration } from '../../growing/artifact-review-composition.js';
import { EntrustedWorkLifecycleService } from '../../growing/EntrustedWorkLifecycleService.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { WorkspaceWritebackService } from '../../workspace/writeback/service.js';
import { reviewModificationBindings } from '../artifact-review/modification-request-reference.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { ContentModificationChatProjection } from './chat-projection.js';
import { ModificationContentBinding } from './content-binding.js';
import { ContentModificationContextService } from './context-service.js';
import { ModificationRuntimeControlService } from './control/runtime-control-service.js';
import { ModificationFileLineage } from './file-lineage.js';
import { ModificationMediaBinding } from './media-binding.js';
import { mediaModificationEvents } from './media-message/media-chat-events.js';
import { MediaPublicationBinding } from './media-publication/media-publication-binding.js';
import { MediaPublicationContinuation } from './media-publication/media-publication-continuation.js';
import { resolveMessageTakeover } from './message-takeover.js';
import { requireModificationSourceMessage } from './request-authority.js';
import { ContentModificationResultService } from './result-service.js';
import { ContentModificationService } from './service.js';
import { ModificationSourceDiscussions } from './source-discussions.js';
import { ModificationTextBinding } from './text/text-binding.js';

export function createContentModificationIntegration(deps: {
  dataDir: string;
  nativeImageArchiveDirectory?: string;
  source: WorkspaceContentSourceService;
  files: WorkspaceContentReviewService;
  artifacts: ReturnType<typeof createArtifactReviewIntegration>;
  tasks: ITaskStore;
  messages: IMessageStore;
  turnExecutions?: Pick<ITurnExecutionStore, 'get'>;
  queue?: Pick<InvocationQueue, 'getEntrySnapshot' | 'getDurableEntriesForMessages'>;
  delivery?: PersistedQueueDeliveryPort;
  changed: (userId: string) => void;
  sourceChanged?: (ownerUserId: string, threadId: string, messageId: string) => void;
  receiptChanged?: (ownerUserId: string, threadId: string, messageId: string) => void;
  onError: (error: unknown) => void;
}) {
  const { store, media, reviews, ledgers, text, targets, dispatcher } = deps.artifacts;
  if (!ledgers || !text) throw new Error('F309 modification requires its F063 source composition');
  const publicationBinding = new MediaPublicationBinding({
    store,
    media,
    messages: deps.messages,
    tasks: deps.tasks,
    ...(deps.turnExecutions ? { turns: deps.turnExecutions } : {}),
    nativeImages: new CodexNativeImageEvidenceReader(deps.nativeImageArchiveDirectory),
    uploadDir: deps.artifacts.uploadDirectory,
  });
  const publicationContinuation = new MediaPublicationContinuation({
    binding: publicationBinding,
    messages: deps.messages,
    dispatcher,
  });
  dispatcher.setPublicationOwner(async (intent) => Boolean(await publicationBinding.validate(intent)));
  reviews.setPublicationResponseGuard(async (requestId, artifactRef, principal) => {
    const intent = store.returns.publicationForRequest(requestId);
    if (!intent) return;
    if (
      principal.actor.kind !== 'cat' ||
      principal.userId !== intent.ownerUserId ||
      principal.actor.actorId !== intent.targetCatId ||
      principal.threadId !== intent.threadId ||
      artifactRef !== intent.source.artifactRef ||
      !(await publicationBinding.currentCaller(intent, principal.invocationId))
    )
      throw new MediaOwnerError('access_denied');
    const publication = await deps.messages.getById(intent.source.publicationMessageId);
    const block = publication?.extra?.rich?.blocks.find((item) => item.id === intent.source.publicationItemId);
    if (block?.kind !== 'media_gallery') throw new MediaOwnerError('access_denied');
    return {
      kind: 'message' as const,
      threadId: intent.threadId,
      messageId: intent.source.publicationMessageId,
      messageRevision: intent.source.artifactRevision,
      expectedUrl: intent.source.artifactRef,
      item: {
        kind: 'media-gallery' as const,
        blockId: block.id,
        itemIndex: block.items.findIndex((item) => item.url === intent.source.artifactRef),
      },
    };
  });
  const lifecycle = new EntrustedWorkLifecycleService(deps.tasks, { onChanged: deps.changed });
  const fileLineage = new ModificationFileLineage({ store, media, messages: deps.messages });
  const content = new ModificationContentBinding({
    source: deps.source,
    media: new ModificationMediaBinding({ store, media, reviews, ledgers, files: deps.files, fileLineage }),
    text: new ModificationTextBinding({ store, source: deps.source, files: deps.files, access: media.access }),
  });
  const requests = new ContentModificationService({
    store,
    messages: deps.messages,
    tasks: deps.tasks,
    ...(deps.queue ? { queue: deps.queue } : {}),
    ...(deps.turnExecutions ? { turnExecutions: deps.turnExecutions } : {}),
    lifecycle,
    content,
    authorizeTarget: (payload, userId) => targets.authorize(payload, userId),
    resolveTakeover: (input, principal, existing) =>
      resolveMessageTakeover(
        {
          messages: deps.messages,
          source: deps.source,
          files: deps.files,
          requests: store.requests,
          tasks: deps.tasks,
          media: { content, reviews, media, files: deps.files, ledgers, store, tasks: deps.tasks },
        },
        input,
        principal,
        existing,
      ),
    dispatch: () => dispatcher.drain(),
    onError: deps.onError,
    hasPublicationContinuation: async (record, principal) => {
      const intent = store.returns.publicationForRequest(record.requestId);
      return Boolean(
        intent &&
          principal.actor.kind === 'cat' &&
          principal.userId === intent.ownerUserId &&
          principal.threadId === intent.threadId &&
          principal.actor.actorId === intent.targetCatId &&
          (await publicationBinding.currentCaller(intent, principal.invocationId)),
      );
    },
    ...(deps.sourceChanged ? { sourceChanged: deps.sourceChanged } : {}),
  });
  const writer = new WorkspaceWritebackService({
    source: deps.source,
    databasePath: join(deps.dataDir, 'workspace', 'writebacks.sqlite'),
    proofDirectory: join(deps.dataDir, 'workspace', 'writeback-proofs'),
  });
  const authorizeMediaReceipt = async (record: ContentModificationRecord) => {
    try {
      return await requireModificationSourceMessage(deps.messages, record);
    } catch (error) {
      if (!(error instanceof MediaOwnerError) || error.code !== 'access_denied') throw error;
      const source = await publicationBinding.receiptSource(record);
      if (!source) throw error;
      return source;
    }
  };
  const receipts: ContentModificationChatProjection = new ContentModificationChatProjection({
    messages: deps.messages,
    tasks: deps.tasks,
    ...(deps.delivery ? { delivery: deps.delivery } : {}),
    store,
    writer,
    mediaEvents: async (record) => {
      if (record.progress.prepared?.kind !== 'media') return [];
      const events = await mediaModificationEvents({ store, reviews, results }, record);
      if (events.length) await authorizeMediaReceipt(record);
      return events;
    },
    authorizeMediaReceipt,
    recoverPublication: (record) => publicationContinuation.recover(record),
    onSaved: deps.receiptChanged ?? (() => {}),
    onError: deps.onError,
  });
  const runtimeControls = new ModificationRuntimeControlService({
    journal: store.requests,
    requests,
    ...(deps.queue ? { queue: deps.queue } : {}),
    ...(deps.turnExecutions ? { turns: deps.turnExecutions } : {}),
  });
  const results: ContentModificationResultService = new ContentModificationResultService({
    store,
    media,
    reviews,
    text,
    writer,
    fileLineage,
    receipts,
  });
  reviews.setCommittedProjection(async (reviewId) => {
    const review = store.get(reviewId);
    if (!review) return;
    for (const { record } of reviewModificationBindings(store, review)) await receipts.projectMedia(record);
  });
  const sourceDiscussions = new ModificationSourceDiscussions({
    store,
    files: deps.files,
    ledgers,
    reviews,
    access: media.access,
    messages: deps.messages,
  });
  const context = new ContentModificationContextService({
    store,
    media,
    reviews,
    requests,
    files: deps.files,
    ledgers,
    messages: deps.messages,
  });
  const recoverySpec: TaskSpec_P1 = {
    id: 'f309-modification-request-recovery',
    profile: 'poller',
    trigger: { type: 'interval', ms: 60_000 },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'content-modification-requests' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute() {
        await requests.recover();
        await receipts.recover();
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '作品修改请求恢复',
      category: 'system',
      description: '续办已确认的请求及真实投递；不会自动接受或写回文件',
      subjectKind: 'none',
    },
  };
  const selection = async (
    input: {
      source: {
        kind: 'workspace';
        locator: { worktreeId: string; path: string };
        reviewId: string;
        expectedSourceRevision: string;
      };
      quote: string;
    },
    principal: MediaReviewPrincipal,
  ) => {
    await deps.files.describeSource({ principal, reviewId: input.source.reviewId, locator: input.source.locator });
    // The quote was selected on the rendered page; the owner maps it to the raw range behind it or refuses.
    const result = await deps.source.resolveRenderedTextSelection({
      principal,
      locator: input.source.locator,
      expectedRevision: input.source.expectedSourceRevision,
      quote: input.quote,
    });
    if (result.status !== 'attached') return { status: result.status };
    return {
      status: result.status,
      selection: { kind: 'text_quote' as const, baseRevision: result.sourceRevision, ...result.anchor },
    };
  };
  return {
    requests,
    results,
    targets,
    text,
    writer,
    recoverySpec,
    selection,
    context,
    sourceDiscussions,
    runtimeControls,
    receipts,
  };
}
