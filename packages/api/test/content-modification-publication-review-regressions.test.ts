import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catConsumableHostSpeaker } from '../src/domains/cats/services/stores/host-message-policy.js';
import { mediaPublicationFixture as fixture } from './helpers/media-publication-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function responseInput(f: Fixture, childId: string) {
  const credentials = f.dispatch.credentials.get(childId);
  assert.ok(credentials);
  const publication = f.messages.getById(String(f.carriers()[0]?.source?.meta?.publicationMessageId));
  assert.ok(publication);
  const review = f.store.get(f.request.record.progress.review!.reviewId)!;
  const round = review.rounds.at(-1)!;
  return {
    method: 'POST' as const,
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: {
      requestId: f.request.record.requestId,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      expectedTaskRevision: review.task.observedRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      expectedLedgerRevision: round.ledgerRevision,
      artifactRef: f.image.urlPath,
      expectedArtifactRevision: String(publication.timestamp),
      operationId: randomUUID(),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '依据原批注交回。',
      })),
    },
  };
}
async function continuation(f: Fixture) {
  f.publish('append');
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  assert.equal(catConsumableHostSpeaker(f.carriers()[0]!), 'Host 作品生成完成：原任务续办');
  return f.dispatch.waitForAwakening(f.carriers()[0]!.id);
}

test('an accepted publication response replays its exact receipt without a new mutation', async (t) => {
  const f = await fixture(t);
  const childId = await continuation(f);
  const input = await responseInput(f, childId);
  const first = await f.app.inject(input);
  assert.equal(first.statusCode, 200, first.body);
  const revision = f.store.get(input.payload.reviewId)!.revision;
  const replay = await f.app.inject(input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().receipt, first.json().receipt);
  assert.equal(f.store.get(input.payload.reviewId)!.revision, revision);
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  const altered = await f.app.inject({
    ...input,
    payload: { ...input.payload, artifactRef: '/uploads/review-input.png' },
  });
  assert.equal(altered.statusCode, 409, altered.body);
  assert.equal(altered.json().error, 'operation_reused');
  assert.equal(f.store.get(input.payload.reviewId)!.revision, revision);
});

for (const boundary of ['original-body-withdrawn', 'return-body-withdrawn'] as const) {
  test(`a lost candidate receipt refuses ${boundary} when recovering its projection`, async (t) => {
    const f = await fixture(t, true);
    await f.markOriginalHandled();
    const childId = await continuation(f);
    f.reviews.setCommittedProjection(async () => {});
    const response = await f.app.inject(await responseInput(f, childId));
    assert.equal(response.statusCode, 200, response.body);
    const before = f.store.get(f.request.record.progress.review!.reviewId)!.revision;
    if (boundary === 'original-body-withdrawn') f.humanMessage.queueCustody!.bodyExposures = [];
    else f.messages.getById(f.carriers()[0]!.id)!.queueCustody!.bodyExposures = [];
    await f.recover();
    assert.equal(
      f.messages
        .getByThread(f.thread.id, 100, 'operator')
        .filter((message) => message.extra?.contentModificationReceiptV1?.state === 'candidate').length,
      0,
    );
    assert.ok(f.errors.some((error) => String(error).includes('access_denied')));
    assert.equal(f.store.get(f.request.record.progress.review!.reviewId)!.revision, before);
  });
}

test('an accepted pending publication response retries using its persisted selector', async (t) => {
  const f = await fixture(t);
  const childId = await continuation(f);
  const input = await responseInput(f, childId);
  const publish = f.media.publishVersion.bind(f.media);
  f.media.publishVersion = async () => {
    throw new Error('fixture_owner_unavailable');
  };
  const failed = await f.app.inject(input);
  assert.equal(failed.statusCode, 500);
  assert.ok(f.store.pendingVersion(input.payload.reviewId));
  f.media.publishVersion = publish;
  const retried = await f.app.inject(input);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  assert.equal(f.store.get(input.payload.reviewId)!.rounds.at(-1)!.asset.ownerRevision, 2);
});

test('a handled multi-target Human receives one candidate receipt with error-free recovery after the child ends', async (t) => {
  const f = await fixture(t, true);
  await f.markOriginalHandled();
  const childId = await continuation(f);
  assert.deepEqual(f.errors, []);
  const input = await responseInput(f, childId);
  const response = await f.app.inject(input);
  assert.equal(response.statusCode, 200, response.body);
  f.dispatch.turns.transitionTerminal(childId, {
    status: 'succeeded',
    terminalReason: 'fixture_candidate_committed',
    endedAt: Date.now(),
  });
  await f.recover();
  await f.recover();
  const receipts = f.messages
    .getByThread(f.thread.id, 100, 'operator')
    .filter(
      (message) =>
        message.extra?.contentModificationReceiptV1?.requestId === f.request.record.requestId &&
        message.extra.contentModificationReceiptV1.state === 'candidate',
    );
  assert.equal(receipts.length, 1, f.errors.map(String).join('; '));
  assert.deepEqual(f.errors, []);
  assert.equal(receipts[0]!.replyTo, f.humanMessage.id);
  assert.equal(receipts[0]!.visibility, 'whisper');
  assert.deepEqual(receipts[0]!.whisperTo, f.humanMessage.whisperTo);
  assert.equal(f.humanMessage.deliveryStatus, 'queued');
  assert.deepEqual(f.humanMessage.queueCustody!.pendingTargetCats, ['sonnet']);
  assert.equal(f.carriers().length, 1);
});

test('one native image cannot choose either of two independent requests covered by its producer', async (t) => {
  const f = await fixture(t, false, { sharedProducer: true });
  const second = f.secondRequest;
  assert.ok(second);
  assert.notEqual(second.record.requestId, f.request.record.requestId);
  assert.notEqual(second.record.progress.task!.taskId, f.request.record.progress.task!.taskId);
  assert.ok(f.child.causal!.coveredMessageIds!.includes(second.record.progress.sourceMessageId!));
  f.publish('append');
  const starts = f.dispatch.starts.length;
  await f.recover();
  await f.recover();
  assert.equal(f.carriers().length, 0);
  assert.equal(f.dispatch.starts.length, starts);
  for (const request of [f.request, second]) {
    assert.equal(f.store.returns.publicationForRequest(request.record.requestId), null);
    assert.equal(f.store.get(request.record.progress.review!.reviewId)!.rounds.length, 1);
  }
});

for (const boundary of ['not-handled', 'other-outcome-child', 'no-producer-body', 'other-custody-owner'] as const) {
  test(`handled Human bridge refuses ${boundary} before registration and wake`, async (t) => {
    const f = await fixture(t, true);
    await f.markOriginalHandled();
    const custody = f.humanMessage.queueCustody!;
    assert.ok(custody.handledByCatIds!.includes('codex-astra'));
    assert.equal(custody.targetOutcomeByCatId!['codex-astra']!.invocationId, f.child.invocationId);
    assert.ok(custody.bodyExposures!.some((item) => item.invocationId === f.child.invocationId));
    if (boundary === 'not-handled') custody.handledByCatIds = [];
    if (boundary === 'other-outcome-child') custody.targetOutcomeByCatId!['codex-astra']!.invocationId = randomUUID();
    if (boundary === 'no-producer-body') custody.bodyExposures = [];
    if (boundary === 'other-custody-owner') custody.ownerUserId = 'another-owner';
    f.publish('append');
    const starts = f.dispatch.starts.length;
    await f.recover();
    assert.equal(f.carriers().length, 0);
    assert.equal(f.store.returns.publicationForRequest(f.request.record.requestId), null);
    assert.equal(f.dispatch.starts.length, starts);
  });
}

for (const producerStatus of ['running', 'canceled'] as const) {
  test(`a ${producerStatus} producer with completed native pixels never registers or wakes a continuation`, async (t) => {
    const f = await fixture(t, false, { producerStatus });
    assert.equal(f.dispatch.turns.get(f.child.invocationId)!.status, producerStatus);
    f.publish('append');
    const starts = f.dispatch.starts.length;
    await f.recover();
    assert.equal(f.store.returns.publicationForRequest(f.request.record.requestId), null);
    assert.equal(f.carriers().length, 0);
    assert.equal(f.dispatch.starts.length, starts);
  });
}
