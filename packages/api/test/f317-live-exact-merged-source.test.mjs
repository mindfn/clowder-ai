import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueA2ATargets } from '../dist/routes/callback-a2a-trigger.js';
import { liveExactDispatchFixture } from './helpers/live-exact-dispatch-fixture.mjs';

for (const targetShape of ['primary', 'merged'])
  test(`Live ${targetShape} source in a merged carrier gains no exact-window authority`, async () => {
    const f = await liveExactDispatchFixture({ coalesced: true });
    const requested = targetShape === 'primary' ? f.source : f.sibling;
    const sibling = targetShape === 'primary' ? f.sibling : f.source;
    try {
      assert.equal((await f.complete(requested)).statusCode, 412);
      const read = await f.read(requested);
      assert.equal(read.statusCode, 200, read.body);
      assert.ok(
        read.json().messages.some((message) => message.id === requested.id && message.content === requested.content),
      );
      assert.ok(!read.json().messages.some((message) => message.id === sibling.id && message.content));
      assert.equal(f.messageStore.getById(requested.id).queueCustody.readEvidenceWitnesses, undefined);
      assert.equal((await f.complete(requested)).statusCode, 412);
    } finally {
      await f.close();
    }
  });

test('Live exact authority is invalidated when its current carrier later becomes merged', async () => {
  const f = await liveExactDispatchFixture();
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    assert.equal(
      f.messageStore.getById(f.source.id).queueCustody.readEvidenceWitnesses?.[0]?.evidenceKind,
      'exact_full_message',
    );
    await f.coalesce('late merged sibling');
    assert.equal((await f.complete(f.source)).statusCode, 412);
  } finally {
    await f.close();
  }
});

test('Live exact authority fails closed when current Queue verification is unavailable', async () => {
  const f = await liveExactDispatchFixture({ authorityQueue: false });
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    assert.equal(
      f.messageStore.getById(f.source.id).queueCustody.readEvidenceWitnesses?.[0]?.evidenceKind,
      'exact_full_message',
    );
    assert.equal((await f.complete(f.source)).statusCode, 412);
  } finally {
    await f.close();
  }
});

test('Live exact terminal append excludes a direct coalesce after current-source validation', async () => {
  const f = await liveExactDispatchFixture();
  let releaseAppend;
  let signalAppend;
  const appendEntered = new Promise((resolve) => {
    signalAppend = resolve;
  });
  const appendBlocked = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  const appendFenced = f.eventLog.appendFenced.bind(f.eventLog);
  f.eventLog.appendFenced = async (event, sequence) => {
    if (event.kind === 'ball.dispatch_dispositioned') {
      signalAppend();
      await appendBlocked;
    }
    return appendFenced(event, sequence);
  };
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    const completion = f.complete(f.source);
    await appendEntered;
    assert.equal(f.queue.remove('thread-1', 'user-1', f.entry.id), null);
    assert.equal(f.queue.markProcessingById('thread-1', f.entry.id, 'codex-sol'), false);
    assert.equal(
      f.queue.coalesceContentIntoQueuedAgent(
        'thread-1',
        'user-1',
        f.entry.id,
        'late body must use another carrier',
        'late-source',
      ),
      false,
    );
    releaseAppend();
    assert.equal((await completion).statusCode, 200);
    assert.equal(
      (await f.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
  } finally {
    releaseAppend();
    await f.close();
  }
});

test('Live exact commit fence releases when terminal append fails', async () => {
  const f = await liveExactDispatchFixture();
  const appendFenced = f.eventLog.appendFenced.bind(f.eventLog);
  let rejectTerminal = true;
  f.eventLog.appendFenced = async (event, sequence) => {
    if (event.kind === 'ball.dispatch_dispositioned' && rejectTerminal) {
      rejectTerminal = false;
      throw new Error('synthetic terminal append failure');
    }
    return appendFenced(event, sequence);
  };
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    assert.equal((await f.complete(f.source)).statusCode, 500);
    assert.equal(f.queue.getEntrySnapshot('thread-1', 'user-1', f.entry.id).queueCustodyAdmissionId, undefined);
    await f.coalesce('coalesce after failed terminal append');
    assert.equal((await f.complete(f.source)).statusCode, 412);
  } finally {
    await f.close();
  }
});

test('legacy Live consumer rejects exact witnesses without a current-source commit boundary', async () => {
  const f = await liveExactDispatchFixture({ legacy: true });
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    await f.coalesce('late sibling on legacy consumer');
    assert.equal((await f.complete(f.source)).statusCode, 412);
    assert.equal(
      (await f.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('same-invocation replay repairs a committed terminal after a later coalesce', async () => {
  const f = await liveExactDispatchFixture({ failReceiptOnce: true });
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    assert.equal((await f.complete(f.source)).statusCode, 500);
    assert.equal(
      (await f.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
    const sibling = await f.coalesce('source arriving after the exact terminal');
    const replay = await f.complete(f.source);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().outcome, 'replayed');
    assert.equal(f.messageStore.getById(f.source.id).deliveryStatus, 'delivered');
    assert.equal(f.messageStore.getById(sibling.id).deliveryStatus, 'queued');
    const remaining = f.queue.list('thread-1', 'user-1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].messageId, sibling.id);
    assert.deepEqual(remaining[0].mergedMessageIds, []);
  } finally {
    await f.close();
  }
});

test('a real callback producer cannot merge through an exact terminal commit boundary', async () => {
  const f = await liveExactDispatchFixture();
  let releaseAppend;
  let signalAppend;
  let signalHandoff;
  const appendEntered = new Promise((resolve) => {
    signalAppend = resolve;
  });
  const appendBlocked = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  const handoffEntered = new Promise((resolve) => {
    signalHandoff = resolve;
  });
  const appendFenced = f.eventLog.appendFenced.bind(f.eventLog);
  f.eventLog.appendFenced = async (event, sequence) => {
    if (event.kind === 'ball.dispatch_dispositioned') {
      signalAppend();
      await appendBlocked;
    }
    return appendFenced(event, sequence);
  };
  const record = f.ingest.record.bind(f.ingest);
  let producer;
  try {
    assert.equal((await f.read(f.source)).statusCode, 200);
    const completion = f.complete(f.source);
    await appendEntered;
    const sibling = f.messageStore.append({
      userId: 'user-1',
      catId: 'fable5',
      threadId: 'thread-1',
      content: 'real producer late sibling',
      mentions: ['codex-sol'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    f.ingest.record = (event) => {
      if (event.kind === 'ball.handed' && event.sourceEventId.includes(sibling.id)) signalHandoff();
      return record(event);
    };
    producer = enqueueA2ATargets(
      {
        invocationQueue: f.queue,
        messageStore: f.messageStore,
        ballCustody: f.ingest,
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex-sol'],
        content: sibling.content,
        userId: 'user-1',
        threadId: 'thread-1',
        ownerAuthProvenance: 'strict',
        callerCatId: 'fable5',
        triggerMessage: sibling,
      },
    );
    await handoffEntered;
    releaseAppend();
    assert.equal((await completion).statusCode, 200);
    const produced = await producer;
    assert.deepEqual(produced.enqueued, ['codex-sol']);
    assert.deepEqual(produced.coalesced, []);
    const remaining = f.queue.list('thread-1', 'user-1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].messageId, sibling.id);
    assert.deepEqual(remaining[0].mergedMessageIds, []);
    const events = await f.eventLog.read('ball:thread:thread-1');
    const terminalIndex = events.findIndex((event) => event.kind === 'ball.dispatch_dispositioned');
    const siblingHandoffIndex = events.findIndex((event) => event.sourceEventId.includes(sibling.id));
    assert.ok(terminalIndex >= 0 && siblingHandoffIndex > terminalIndex);
  } finally {
    releaseAppend();
    if (producer) await producer.catch(() => {});
    await f.close();
  }
});
