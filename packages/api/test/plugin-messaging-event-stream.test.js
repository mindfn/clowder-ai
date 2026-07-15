/**
 * K-1 / F258 — event stream subscriptions (plan Task 6, §4b)
 * AC-3: durable ack cursor, at-least-once redelivery (INV-4), opaque
 * subscription-local token (INV-5), stale + snapshot catch-up (INV-9).
 * Real stack; events produced via real SendService.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let streamMod;
let MessageStore;

let messageStore;
let handles;
let events;
let sendService;
let stream;

const RETENTION = 5;
const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  streamMod = await import('../dist/domains/messaging/event-stream.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  const cursors = new memory.MemoryCursorStore();
  handles = new handlesMod.HandleService(new memory.MemoryHandleStore(), cursors);
  events = new memory.MemoryEventLogStore();
  sendService = new sendMod.SendService({
    messageStore,
    handles,
    ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
    events,
    retentionCount: RETENTION,
  });
  stream = new streamMod.EventStreamService({
    events,
    cursors,
    handles,
    messageStore,
    retentionCount: RETENTION,
  });
});

async function issueHandle(scope = { canSend: true, canSubscribe: true }) {
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'user-1',
    scope,
  });
  return handleId;
}

async function sendN(handleId, n, prefix = 'msg') {
  for (let i = 1; i <= n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: `${prefix}-${i}`,
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: `${prefix} ${i}` } }],
      },
    });
  }
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected MessagingError(${code}), but call succeeded`);
}

describe('EventStreamService — subscribe', () => {
  test('subscribe starts at current head: only future events delivered', async () => {
    const handleId = await issueHandle();
    await sendN(handleId, 2, 'before');
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    const empty = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(empty.events, []);
    assert.equal(empty.ackToken, null);
    await sendN(handleId, 1, 'after');
    const next = await stream.read(CTX, subscriptionId, {});
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0].envelope.payload.elements[0].payload.text, 'after 1');
  });

  test('subscribe is idempotent per (instance, handle)', async () => {
    const handleId = await issueHandle();
    const first = await stream.subscribe(CTX, handleId);
    const second = await stream.subscribe(CTX, handleId);
    assert.equal(second.subscriptionId, first.subscriptionId);
  });

  test('subscribe without canSubscribe scope → PERMISSION', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: false });
    await expectCode(stream.subscribe(CTX, handleId), 'PERMISSION');
  });
});

describe('EventStreamService — read/ack (INV-4, INV-5)', () => {
  test('INV-4: unacked events are redelivered; acked events are not', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 3);

    const first = await stream.read(CTX, subscriptionId, {});
    assert.equal(first.events.length, 3);
    const again = await stream.read(CTX, subscriptionId, {});
    assert.equal(again.events.length, 3, 'no ack → same events redelivered');

    await stream.ack(CTX, subscriptionId, again.ackToken);
    const after = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(after.events, [], 'acked events never redelivered on the same subscription');
  });

  test('read respects limit and delivers ascending', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 3);
    const page = await stream.read(CTX, subscriptionId, { limit: 2 });
    assert.deepEqual(
      page.events.map((e) => e.sequence),
      [1, 2],
    );
    await stream.ack(CTX, subscriptionId, page.ackToken);
    const rest = await stream.read(CTX, subscriptionId, {});
    assert.deepEqual(
      rest.events.map((e) => e.sequence),
      [3],
    );
  });

  test('INV-5: ack token from subscription A rejected on subscription B', async () => {
    const handleA = await issueHandle();
    const issuedB = await handles.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-2',
      userId: 'user-1',
      scope: { canSend: false, canSubscribe: true },
    });
    const subA = await stream.subscribe(CTX, handleA);
    const subB = await stream.subscribe(CTX, issuedB.handleId);
    await sendN(handleA, 1);
    const readA = await stream.read(CTX, subA.subscriptionId, {});
    await expectCode(stream.ack(CTX, subB.subscriptionId, readA.ackToken), 'PERMISSION');
  });

  test('malformed or forged tokens rejected', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 1);
    await stream.read(CTX, subscriptionId, {});
    await expectCode(stream.ack(CTX, subscriptionId, 'garbage-token'), 'VALIDATION');
    const forged = Buffer.from(JSON.stringify({ s: subscriptionId, q: 999, n: 'x' })).toString('base64url');
    await expectCode(stream.ack(CTX, subscriptionId, forged), 'PERMISSION');
  });

  test('unknown subscription → NOT_FOUND; foreign instance → NOT_FOUND scope', async () => {
    await expectCode(stream.read(CTX, 'sub_missing', {}), 'NOT_FOUND');
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await expectCode(stream.read({ pluginInstanceId: 'inst-b' }, subscriptionId, {}), 'NOT_FOUND');
  });

  test('read on revoked subscription (handle revoke cascade) → PERMISSION', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await handles.revoke(handleId);
    await expectCode(stream.read(CTX, subscriptionId, {}), 'PERMISSION');
    await expectCode(stream.subscribe(CTX, handleId), 'PERMISSION');
  });
});

describe('EventStreamService — stale + snapshot (INV-9)', () => {
  test('cursor behind retention floor → stale read with zero events, never silent skip', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, RETENTION + 3); // events 1..8, retained 4..8, cursor at 0
    const result = await stream.read(CTX, subscriptionId, {});
    assert.equal(result.stale, true);
    assert.deepEqual(result.events, []);
    assert.equal(result.ackToken, null);
  });

  test('snapshot catches up: envelopes + resumeSequence; subsequent reads resume live', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, RETENTION + 3);
    const snap = await stream.snapshot(CTX, subscriptionId);
    assert.equal(snap.resumeSequence, RETENTION + 3);
    assert.equal(snap.envelopes.length, RETENTION + 3, 'snapshot returns thread messages as envelopes');
    const live = await stream.read(CTX, subscriptionId, {});
    assert.equal(live.stale, false);
    assert.deepEqual(live.events, []);
    await sendN(handleId, 1, 'fresh');
    const next = await stream.read(CTX, subscriptionId, {});
    assert.equal(next.events.length, 1);
  });

  test('snapshot excludes whisper and deleted messages (fail-closed visibility)', async () => {
    const handleId = await issueHandle({ canSend: true, canSubscribe: true, allowedWhisperTargets: ['cat-a'] });
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 1, 'public');
    await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'whisper-1',
      draftAudience: { kind: 'whisper', targets: ['cat-a'] },
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'secret' } }],
      },
    });
    const deleted = await sendService.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'doomed-1',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'to delete' } }],
      },
    });
    messageStore.softDelete(deleted.messageId, 'user-1');
    const snap = await stream.snapshot(CTX, subscriptionId);
    const texts = snap.envelopes.map((e) => e.payload.elements[0].payload.text);
    assert.ok(texts.includes('public 1'));
    assert.ok(!texts.includes('secret'), 'whisper excluded from snapshot');
    assert.ok(!texts.includes('to delete'), 'deleted excluded from snapshot');
  });

  test('ack of previously delivered events stays valid across trim (can cure staleness)', async () => {
    const handleId = await issueHandle();
    const { subscriptionId } = await stream.subscribe(CTX, handleId);
    await sendN(handleId, 2);
    const read1 = await stream.read(CTX, subscriptionId, {}); // delivered 1..2
    await sendN(handleId, RETENTION, 'more'); // total 7, retained 3..7 → floor 3
    await stream.ack(CTX, subscriptionId, read1.ackToken); // ack 2 → cursor 2 ≥ floor-1 (2)
    const result = await stream.read(CTX, subscriptionId, {});
    assert.equal(result.stale, false, 'ack of delivered events stays valid after trim');
    assert.deepEqual(
      result.events.map((e) => e.sequence),
      [3, 4, 5, 6, 7],
    );
  });
});
