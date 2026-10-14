import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type TestContext, test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { modificationMessageRequestId } from '../src/domains/collaborative-content/modification/journal.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { firstFileFixture } from './helpers/content-modification-first-file-fixture.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

async function fixture(t: TestContext, kind: 'md' | 'ts' | 'png' | 'mp4' = 'md') {
  const f =
    kind === 'md' || kind === 'ts'
      ? await firstFileFixture(t, kind === 'md' ? 'guide.md' : 'guide.ts')
      : await mediaMessageFixture(t, kind === 'png' ? 'image/png' : 'video/mp4');
  const message = 'message' in f ? f.message : f.send();
  const auth = 'auth' in f ? f.auth : f.actor;
  const target = f.cat.actor.actorId;
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: f.messages });
  assert.equal(f.messages.prepareQueueAdmission(message.id).kind, 'prepared');
  const admitted = queue.enqueue({
    threadId: f.thread.id,
    userId: 'operator',
    ownerAuthProvenance: 'strict',
    messageId: message.id,
    content: message.content,
    targetCats: [target],
    source: 'user',
    intent: 'execute',
  });
  assert.ok(admitted.entry);
  const entry = admitted.entry;
  assert.equal(
    f.messages.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(entry)).kind,
    'initialized',
  );
  async function expose(invocationId = auth.invocationId, catId: string = target) {
    queue.markQueuedSeen(f.thread.id, 'operator', entry.id, catId, invocationId);
    const current = queue.getEntrySnapshot(f.thread.id, 'operator', entry.id);
    assert.ok(current);
    await coordinator.persistEntry(current);
    await coordinator.assertPromptExposurePersisted([message.id], catId, invocationId);
  }
  const takeover = (extra: Record<string, unknown> = {}) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { sourceMessageId: message.id, operationId: randomUUID(), ...extra },
    });
  const fileStore = 'fileStore' in f ? f.fileStore : f.filesStore;
  const reviewId = 'reviewId' in f ? f.reviewId : '';
  const taskCount = f.tasks.listByThread(f.thread.id).length;
  return { ...f, fileStore, reviewId, taskCount, message, auth, target, queue, coordinator, entry, expose, takeover };
}

for (const kind of ['md', 'ts', 'png', 'mp4'] as const) {
  test(`queued ${kind}: exact exposed callback takes over before global delivery, without settling the Human`, async (t) => {
    const f = await fixture(t, kind);
    await f.expose();
    const before = structuredClone(f.messages.getById(f.message.id)?.queueCustody);
    const count = f.tasks.listByThread(f.thread.id).length;
    const result = await f.takeover();
    assert.equal(result.statusCode, 200, result.body);
    const record = result.json().record;
    assert.equal(result.json().stage, 'queued', JSON.stringify(record.issue));
    assert.equal(record.progress.sourceMessageId, f.message.id);
    assert.equal(record.progress.sourceKind, 'human_message');
    assert.equal(record.payload.intent.body, f.message.content);
    assert.equal(record.payload.targetCatId, f.target);
    assert.equal(record.payload.threadId, f.thread.id);
    assert.equal(f.messages.getById(f.message.id)?.deliveryStatus, 'queued');
    assert.deepEqual(f.messages.getById(f.message.id)?.queueCustody, before);
    const repeat = await f.takeover();
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(repeat.json().record.requestId, record.requestId);
    assert.equal(f.tasks.listByThread(f.thread.id).length, count + (kind === 'md' || kind === 'ts' ? 1 : 0));
    if (kind === 'md' || kind === 'ts') {
      const read = await f.integration.text.read(record.requestId, f.cat);
      const quote = kind === 'md' ? 'First unique paragraph.' : 'Hello first file';
      const start = read.source.text.indexOf(quote);
      assert.ok(start >= 0);
      const returned = await f.integration.text.respond(
        {
          requestId: record.requestId,
          operationId: randomUUID(),
          expectedTaskRevision: read.taskRevision,
          expectedProposalRevision: 0,
          baseRevision: read.source.source.revision,
          edits: [{ start, end: start + quote.length, expectedText: quote, replacement: `${quote} Updated.` }],
          response: 'Updated the queued Human quotation.',
        },
        f.cat,
      );
      assert.equal(
        await readFile(returned.candidatePath, 'utf8'),
        read.source.text.replace(quote, `${quote} Updated.`),
      );
      const candidate = await f.integration.text.candidate(record.requestId, returned.proposal.proposalRef, f.human);
      const accepted = await f.integration.writer.accept(
        {
          acceptOperationId: randomUUID(),
          requestId: record.requestId,
          candidateRef: returned.proposal.proposalRef,
          locator: candidate.source.locator,
          baseRevision: candidate.source.revision,
          bytes: candidate.bytes,
        },
        { userId: 'operator', editSessionToken: signEditToken(candidate.source.locator.worktreeId) },
      );
      assert.equal(accepted.state, 'applied');
      assert.notEqual(f.tasks.get(record.progress.task.taskId)?.status, 'done');
    } else if ('candidate' in f) {
      await f.candidate(record.requestId);
    }
    assert.equal(f.messages.getById(f.message.id)?.deliveryStatus, 'queued');
    assert.deepEqual(f.messages.getById(f.message.id)?.queueCustody, before);
  });
}

for (const boundary of [
  'unseen',
  'different-child',
  'different-cat',
  'awakened-only',
  'forged-payload-child',
  'superseded-child',
  'old-body-current-child',
  'other-cat-current-child',
] as const) {
  test(`queued ${boundary}: callback cannot borrow someone else's exposure`, async (t) => {
    const f = await fixture(t);
    if (boundary === 'different-child' || boundary === 'forged-payload-child') await f.expose('old-child');
    if (boundary === 'superseded-child') {
      await f.expose();
      await f.expose('replacement-child');
    }
    if (boundary === 'old-body-current-child') {
      await f.expose('old-child');
      const custody = f.messages.getById(f.message.id)?.queueCustody;
      assert.ok(custody);
      custody.seenInvocationIdByCatId[f.target] = f.auth.invocationId;
    }
    if (boundary === 'other-cat-current-child') {
      await f.expose();
      const custody = f.messages.getById(f.message.id)?.queueCustody;
      assert.ok(custody);
      custody.bodyExposures = [{ targetCatId: 'sonnet', invocationId: f.auth.invocationId, seenAt: Date.now() }];
    }
    if (boundary === 'different-cat') {
      const custody = f.messages.getById(f.message.id)?.queueCustody;
      assert.ok(custody);
      custody.bodyExposures = [{ targetCatId: 'sonnet', invocationId: f.auth.invocationId, seenAt: Date.now() }];
    }
    if (boundary === 'awakened-only') {
      const custody = f.messages.getById(f.message.id)?.queueCustody;
      assert.ok(custody);
      custody.awakenedInvocationIdByCatId = { [f.target]: f.auth.invocationId };
    }
    const result = await f.takeover(boundary === 'forged-payload-child' ? { invocationId: 'old-child' } : {});
    assert.equal(result.statusCode, boundary === 'forged-payload-child' ? 400 : 404, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.store.requests.get(modificationMessageRequestId('operator', f.message.id), 'operator'), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

for (const boundary of [
  'owner',
  'thread',
  'mention',
  'whisper',
  'recall',
  'deleted',
  'canceled',
  'withdrawn',
] as const) {
  test(`exposed queued ${boundary}: other authority still fences takeover`, async (t) => {
    const f = await fixture(t);
    await f.expose();
    if (boundary === 'owner') f.message.userId = 'someone-else';
    if (boundary === 'thread') f.message.threadId = 'another-thread';
    if (boundary === 'mention') f.message.mentions = [];
    if (boundary === 'whisper') {
      f.message.visibility = 'whisper';
      f.message.whisperTo = [];
    }
    if (boundary === 'recall') f.message.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
    if (boundary === 'deleted') f.messages.softDelete(f.message.id, 'operator');
    if (boundary === 'canceled') f.messages.markCanceled(f.message.id);
    if (boundary === 'withdrawn') await f.coordinator.withdrawEntry(f.entry);
    const result = await f.takeover();
    assert.equal(result.statusCode, 404, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

test('queued source withdrawn during quote mapping is rejected before canonical review creation', async (t) => {
  const f = await fixture(t);
  await f.expose();
  const resolve = f.source.resolveRenderedTextSelections.bind(f.source);
  f.source.resolveRenderedTextSelections = async (input) => {
    const result = await resolve(input);
    await f.coordinator.withdrawEntry(f.entry);
    return result;
  };
  const result = await f.takeover();
  assert.equal(result.statusCode, 404, result.body);
  assert.equal(f.fileStore.get(f.reviewId), null);
  assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
});

test('agent-key-style domain principal cannot use queued exposure without an authenticated invocation identity', async (t) => {
  const f = await fixture(t);
  await f.expose();
  await assert.rejects(
    f.integration.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.cat),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'not_found',
  );
  assert.equal(f.fileStore.get(f.reviewId), null);
});

for (const boundary of [
  'custody-owner',
  'terminal',
  'pending-target',
  'lost-exposure',
  'old-body-current-child',
  'other-cat-current-child',
] as const) {
  test(`committed queued request ${boundary}: journal does not replace current source custody`, async (t) => {
    const f = await fixture(t);
    await f.expose();
    const admitted = await f.takeover();
    assert.equal(admitted.statusCode, 200, admitted.body);
    assert.equal(admitted.json().stage, 'queued', JSON.stringify(admitted.json().record.issue));
    const custody = f.messages.getById(f.message.id)?.queueCustody;
    assert.ok(custody);
    if (boundary === 'custody-owner') custody.ownerUserId = 'someone-else';
    if (boundary === 'terminal') custody.status = 'terminal';
    if (boundary === 'pending-target') custody.pendingTargetCats = [];
    if (boundary === 'lost-exposure') custody.bodyExposures = [];
    if (boundary === 'old-body-current-child') custody.seenInvocationIdByCatId[f.target] = 'replacement-child';
    if (boundary === 'other-cat-current-child') {
      custody.bodyExposures = [{ targetCatId: 'sonnet', invocationId: f.auth.invocationId, seenAt: Date.now() }];
    }
    const replay = await f.takeover();
    assert.equal(replay.statusCode, 404, replay.body);
    await assert.rejects(f.integration.text.read(admitted.json().record.requestId, f.cat), /access_denied/);
  });
}
