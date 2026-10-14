import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import sharp from 'sharp';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { scanAndPublishCodexImages } from '../../src/domains/cats/services/agents/providers/codex-image-scanner.js';
import { CliRawArchive } from '../../src/domains/cats/services/session/CliRawArchive.js';
import { mediaMessageFixture } from './media-message-fixture.js';

export async function mediaPublicationFixture(
  t: Parameters<typeof mediaMessageFixture>[0],
  multiTarget = false,
  options: {
    producerStatus?: 'succeeded' | 'running' | 'canceled';
    sharedProducer?: boolean;
    publicationLedger?: boolean;
  } = {},
) {
  const nativeRoot = await mkdtemp(join(tmpdir(), 'f309-publication-native-'));
  t.after(() => rm(nativeRoot, { recursive: true, force: true }));
  let fixtureRef: Awaited<ReturnType<typeof mediaMessageFixture>> | undefined;
  const f = await mediaMessageFixture(
    t,
    'image/png',
    { get: (id) => fixtureRef?.dispatch.turns.get(id) ?? null },
    {
      authenticatedQueue: true,
      nativeImageArchiveDirectory: join(nativeRoot, 'raw'),
      publicationLedger: options.publicationLedger,
    },
  );
  fixtureRef = f;
  const human = f.send();
  if (multiTarget) {
    human.mentions.push(createCatId('sonnet'));
    human.whisperTo?.push(createCatId('sonnet'));
  }
  const blocked = options.sharedProducer
    ? f.dispatch.tracker.start(f.thread.id, 'codex-astra', 'operator', ['codex-astra'])
    : undefined;
  const request = await f.takeOver(human.id);
  const receipt = request.record.progress.review?.receiptRef;
  assert.ok(receipt);
  const key = `f309-return:${createHash('sha256').update(receipt).digest('hex')}`;
  const initial = f.messages.getByIdempotencyKey('operator', f.thread.id, key);
  assert.ok(initial);
  let secondRequest: typeof request | undefined;
  let secondCarrierId: string | undefined;
  if (options.sharedProducer) {
    const admitted = await f.lifecycle.admitOrResume({
      task: {
        threadId: f.thread.id,
        userId: 'operator',
        ownerCatId: createCatId('codex-astra'),
        createdBy: createCatId('codex-astra'),
        title: '第二份独立封面',
        why: '共同审阅另一份产物',
      },
      admission: {
        basis: 'explicit_entrustment',
        idempotencyKey: 'second-cover',
        sourceRefs: ['message:second-cover'],
        intendedOutcome: '审阅第二份封面',
      },
      closure: { condition: '完成第二份封面', expectedSignal: 'reviewed-publication' },
      time: { reviewBy: { value: Date.now() + 3600000, sourceRef: 'message:second-cover' } },
      artifactRefs: ['/uploads/review-input.png'],
    });
    assert.ok('subjectRef' in admitted && admitted.subjectRef);
    const taskId = admitted.subjectRef.replace(/^task:work:/, '');
    const review = await f.reviews.prepare({ ...f.prepare, taskId, operationId: 'prepare-second-cover' }, f.human);
    const second = f.send({
      ...f.attachment,
      id: 'second-image',
      source: {
        ...f.attachment.source,
        reviewId: review.review.reviewId,
        expectedReviewRevision: review.review.revision,
      },
      taskContext: {
        ...f.attachment.taskContext!,
        taskId,
        reviewId: review.review.reviewId,
        expectedTaskRevision: review.authority.taskRevision,
        expectedReviewRevision: review.review.revision,
      },
    });
    secondRequest = await f.takeOver(second.id);
    const secondReceipt = secondRequest.record.progress.review!.receiptRef;
    secondCarrierId = f.messages.getByIdempotencyKey(
      'operator',
      f.thread.id,
      `f309-return:${createHash('sha256').update(secondReceipt).digest('hex')}`,
    )!.id;
    const entry = f.queue.findEntryWithMessageId(f.thread.id, initial.id)!;
    // The deterministic provider consumes the second request too; real child creation and body exposure persist the causal binding.
    f.dispatch.coverOnNextProviderStart([second.id, secondCarrierId]);
    f.dispatch.tracker.complete(f.thread.id, 'codex-astra', blocked);
    await f.dispatch.processor.progressOwnedCarrier(entry, 'codex-astra');
  }
  const childId = await f.dispatch.waitForAwakening(initial.id);
  const child = f.dispatch.turns.get(childId);
  assert.ok(child);
  if (secondCarrierId) {
    const entry = f.queue.findEntryWithMessageId(f.thread.id, secondCarrierId)!;
    f.queue.markQueuedSeen(f.thread.id, 'operator', entry.id, 'codex-astra', childId);
    await f.dispatch.coordinator.persistEntry(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id)!);
    await f.dispatch.coordinator.assertPromptExposurePersisted([secondCarrierId], 'codex-astra', childId);
  }
  const sessionId = 'native-publication-session';
  const codexHome = join(nativeRoot, 'codex');
  const sourcePath = join(codexHome, 'generated_images', sessionId, 'exec-generated.png');
  await mkdir(join(codexHome, 'generated_images', sessionId), { recursive: true });
  const pixels = await sharp({ create: { width: 160, height: 100, channels: 3, background: 'green' } })
    .png()
    .toBuffer();
  await writeFile(sourcePath, pixels);
  const envelopes = [
    { direction: 'outbound', envelope: { id: 11, method: 'turn/start', params: { threadId: sessionId } } },
    { direction: 'inbound', envelope: { id: 11, result: { turn: { id: 'native-producing-turn' } } } },
    {
      direction: 'inbound',
      envelope: {
        method: 'item/completed',
        params: {
          threadId: sessionId,
          turnId: 'native-producing-turn',
          item: {
            type: 'imageGeneration',
            id: 'exec-generated',
            status: 'completed',
            failure: null,
            savedPath: sourcePath,
            result: pixels.toString('base64'),
          },
        },
      },
    },
  ];
  const archive = new CliRawArchive({ archiveDir: join(nativeRoot, 'raw') });
  for (const entry of envelopes) await archive.append(childId, { transport: 'codex_app_server', ...entry });
  const images = await scanAndPublishCodexImages({
    codexSessionId: sessionId,
    codexHome,
    uploadDir: f.root,
    nativeSource: { invocationId: childId, envelopes },
  });
  assert.equal(images.length, 1, 'real copied pixels and native generation must exist before recovery');
  const image = images[0]!;
  assert.deepEqual(await readFile(image.absPath), pixels);
  if (options.producerStatus !== 'running') {
    f.dispatch.turns.transitionTerminal(childId, {
      status: options.producerStatus ?? 'succeeded',
      terminalReason: options.producerStatus === 'canceled' ? 'user_stop' : 'fixture_native_output_completed',
      endedAt: Date.now(),
    });
    await f.dispatch.releaseProvider(childId);
  }
  const projection = {
    invocationId: childId,
    parentInvocationId: child.parentInvocationId,
    executionKind: child.executionKind,
  };
  function publish(mode: 'append' | 'augment' | 'bare') {
    const message = f.messages.append({
      userId: 'operator',
      threadId: f.thread.id,
      catId: createCatId('codex-astra'),
      mentions: [],
      timestamp: Date.now(),
      content: '原回合生成的图片',
      visibility: 'whisper',
      whisperTo: human.whisperTo ?? [],
      extra: { turnExecution: projection, ...(mode === 'append' ? { rich: { v: 1, blocks: [image.richBlock] } } : {}) },
    });
    if (mode === 'augment')
      f.messages.augmentStreamMetadata(message.id, {
        extra: { turnExecution: projection, rich: { v: 1, blocks: [image.richBlock] } },
      });
    return f.messages.getById(message.id)!;
  }
  const recover = () =>
    f.integration.recoverySpec.run.execute(null, 'content-modification-requests', {
      signal: new AbortController().signal,
      assignedCatId: null,
    });
  const carriers = () =>
    f.messages
      .getByThreadIncludingQueued(f.thread.id, 100, 'operator')
      .filter((message) => message.source?.meta?.kind === 'resume_media_publication');
  async function markOriginalHandled() {
    const queue = new InvocationQueue();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: f.messages });
    assert.equal(f.messages.prepareQueueAdmission(human.id).kind, 'prepared');
    const { entry } = queue.enqueue({
      threadId: f.thread.id,
      userId: 'operator',
      ownerAuthProvenance: 'strict',
      messageId: human.id,
      content: human.content,
      targetCats: human.mentions,
      source: 'user',
      intent: 'execute',
    });
    assert.ok(entry);
    assert.equal(
      f.messages.initializeQueueCustody(human.id, createInitialQueuedMessageCustody(entry)).kind,
      'initialized',
    );
    queue.markQueuedSeen(f.thread.id, 'operator', entry.id, 'codex-astra', childId);
    const exposed = queue.getEntrySnapshot(f.thread.id, 'operator', entry.id);
    assert.ok(exposed);
    await coordinator.persistEntry(exposed);
    await coordinator.assertPromptExposurePersisted([human.id], 'codex-astra', childId);
    await coordinator.commitSuccessfulTargets(exposed, ['codex-astra'], childId, Date.now());
    assert.equal(f.messages.getById(human.id)?.deliveryStatus, 'queued');
    assert.deepEqual(f.messages.getById(human.id)?.queueCustody?.pendingTargetCats, ['sonnet']);
  }
  return {
    ...f,
    nativeRoot,
    sourcePath,
    envelopes,
    humanMessage: human,
    request,
    secondRequest,
    child,
    image,
    publish,
    recover,
    carriers,
    markOriginalHandled,
  };
}
