import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-runtime-quote.json', import.meta.url), 'utf8'));

async function setup(overrides = {}) {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
    ...overrides,
  });
  const { invocationId, callbackToken } = await registry.create('default-user', 'codex61-sol');
  const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  return { app, messageStore, headers, invocationId };
}

test('queued transcript timestamps retain durable enqueue time across repeated reads', async () => {
  const invocationQueue = new InvocationQueue();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const { app, headers, invocationId } = await setup({ invocationQueue, turnExecutionStore });
  try {
    await turnExecutionStore.createRunning({
      invocationId,
      parentInvocationId: invocationId,
      threadId: 'default',
      userId: 'default-user',
      catId: 'codex61-sol',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    const { entry } = invocationQueue.enqueue({
      ownerAuthProvenance: 'strict',
      threadId: 'default',
      userId: 'default-user',
      content: 'queued agent notice',
      source: 'agent',
      callerCatId: 'codex-sol',
      targetCats: ['codex61-sol'],
      intent: 'execute',
    });
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
      assert.equal(response.statusCode, 200, response.body);
      const message = response.json().messages.find((m) => m.queueEntryId === entry.id);
      assert.equal(message.timestamp, entry.createdAt, 'reading must not manufacture a new event time');
    }
  } finally {
    await app.close();
  }
});

test('queued runtime quote is exposed as the same complete body in context and exact drill', async () => {
  const invocationQueue = new InvocationQueue();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const { app, messageStore, headers, invocationId } = await setup({
    invocationQueue,
    turnExecutionStore,
    queueProcessor: { markPromptMessagesSeen: async () => [] },
  });
  try {
    await turnExecutionStore.createRunning({
      invocationId,
      parentInvocationId: invocationId,
      threadId: 'default',
      userId: 'default-user',
      catId: 'codex61-sol',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    const { entry } = invocationQueue.enqueue({
      ownerAuthProvenance: 'strict',
      threadId: 'default',
      userId: 'default-user',
      content: '',
      source: 'user',
      targetCats: ['codex61-sol'],
      authorIntentByCatId: { 'codex61-sol': { requested: 'continue_current', boundParentInvocationId: invocationId } },
      intent: 'execute',
    });
    const message = messageStore.append({
      userId: 'default-user',
      threadId: 'default',
      catId: null,
      content: '',
      contentBlocks: fixture.contentBlocks,
      mentions: [],
      timestamp: fixture.timestamp,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(entry),
    });
    invocationQueue.backfillMessageId('default', 'default-user', entry.id, message.id);
    const context = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(drill.statusCode, 200, drill.body);
    const projected = context.json().messages.find((m) => m.id === message.id);
    assert.equal(projected.content, drill.json().message.content);
    assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
    assert.match(projected.content, /可以啊 你喊他继续啊/);
    assert.equal(projected.contentLength, projected.content.length);
  } finally {
    await app.close();
  }
});

for (const sourceCase of ['missing', 'foreign']) {
  test(`queued ${sourceCase} source stays unexposed while other readable bodies remain available`, async () => {
    const invocationQueue = new InvocationQueue();
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    const { app, messageStore, headers, invocationId } = await setup({
      invocationQueue,
      turnExecutionStore,
      deliveryCursorStore: new DeliveryCursorStore(),
    });
    try {
      await turnExecutionStore.createRunning({
        invocationId,
        parentInvocationId: invocationId,
        threadId: 'default',
        userId: 'default-user',
        catId: 'codex61-sol',
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      const readable = messageStore.append({
        userId: 'default-user',
        catId: null,
        content: 'readable original',
        mentions: [],
        timestamp: 1,
      });
      const { entry } = invocationQueue.enqueue({
        ownerAuthProvenance: 'strict',
        threadId: 'default',
        userId: 'default-user',
        content: 'queue text alone is incomplete',
        source: 'user',
        targetCats: ['codex61-sol'],
        authorIntentByCatId: {
          'codex61-sol': { requested: 'continue_current', boundParentInvocationId: invocationId },
        },
        intent: 'execute',
      });
      const sourceId =
        sourceCase === 'missing'
          ? 'missing-source'
          : messageStore.append({
              userId: 'other-user',
              catId: null,
              content: 'private content',
              contentBlocks: fixture.contentBlocks,
              mentions: [],
              timestamp: 2,
            }).id;
      invocationQueue.backfillMessageId('default', 'default-user', entry.id, sourceId);
      const response = await app.inject({
        url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const messages = response.json().messages;
      assert.equal(messages.find((m) => m.id === readable.id).content, readable.content);
      const pending = messages.find((m) => m.queueEntryId === entry.id);
      assert.equal(pending.truncated, true);
      assert.equal(pending.sourceUnavailableReason, 'queued_body_source_unavailable');
      assert.equal(pending.content, undefined);
      assert.equal(pending.contentBlocks, undefined);
      assert.equal(invocationQueue.getEntrySnapshot('default', 'default-user', entry.id).queuedSeenByCatIds, undefined);
      assert.equal(response.body.includes('private content'), false);
    } finally {
      await app.close();
    }
  });
}

test('runtime quote source retains the paired owner comment and original provenance in both full readers', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: fixture.contentBlocks,
      mentions: [],
      timestamp: fixture.timestamp,
    });
    const context = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(drill.statusCode, 200, drill.body);
    for (const projected of [context.json().messages[0], drill.json().message]) {
      assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
      assert.match(projected.content, /可以啊 你喊他继续啊/);
      assert.equal(projected.contentLength, projected.content.length);
      assert.equal(projected.truncated, false);
      assert.equal(projected.speaker, 'co-creator');
    }
    assert.equal(context.json().messages[0].content, drill.json().message.content);
  } finally {
    await app.close();
  }
});

for (const outerComment of ['', '请按这段批注继续']) {
  test(`pending mention anchor/full retains the runtime quote with ${outerComment ? 'an outer comment' : 'empty text'}`, async () => {
    const { app, messageStore, headers } = await setup();
    try {
      const message = messageStore.append({
        userId: 'default-user',
        catId: null,
        content: outerComment,
        contentBlocks: fixture.contentBlocks,
        mentions: ['codex61-sol'],
        timestamp: fixture.timestamp,
      });
      const full = await app.inject({ url: '/api/callbacks/pending-mentions?responseMode=full', headers });
      const anchor = await app.inject({ url: '/api/callbacks/pending-mentions', headers });
      const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
      assert.equal(full.statusCode, 200, full.body);
      assert.equal(anchor.statusCode, 200, anchor.body);
      assert.equal(drill.statusCode, 200, drill.body);
      const complete = full.json().mentions[0];
      const excerpt = anchor.json().mentions[0];
      assert.equal(complete.id, message.id);
      assert.deepEqual(complete.contentBlocks, fixture.contentBlocks);
      assert.match(complete.message, /可以啊 你喊他继续啊/);
      assert.equal(complete.message, drill.json().message.content);
      assert.equal(complete.contentLength, complete.message.length);
      assert.equal(complete.requiresDrill, false);
      assert.equal(complete.from, 'co-creator');
      if (outerComment) assert.ok(complete.message.startsWith(outerComment));
      assert.ok(excerpt.message.length > 0);
      assert.equal(excerpt.contentLength, complete.contentLength);
      assert.equal(excerpt.requiresDrill, excerpt.message !== complete.message);
      assert.equal(excerpt.drillDown.args.messageId, message.id);
      assert.equal(excerpt.contentBlocks, undefined, 'anchor remains bounded; full drill retains attachments');
    } finally {
      await app.close();
    }
  });
}

test('oversized quote remains unseen until its full drill is actually returned', async () => {
  const deliveryCursorStore = new DeliveryCursorStore();
  const { app, messageStore, headers } = await setup({ deliveryCursorStore });
  try {
    const attachment = structuredClone(fixture.contentBlocks[0].attachment);
    attachment.text = 'x'.repeat(15000);
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: [{ type: 'context_attachment', attachment }],
      mentions: [],
      timestamp: 1,
    });
    const response = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Buffer.byteLength(response.body) <= 24000);
    const projected = response.json().messages[0];
    assert.equal(projected.id, message.id);
    assert.equal(projected.oversized, true);
    assert.equal(projected.truncated, true);
    assert.ok(projected.contentLength > 15000);
    assert.equal(await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default'), undefined);
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(drill.statusCode, 200, drill.body);
    assert.equal(drill.json().message.contentBlocks[0].attachment.text, attachment.text);
  } finally {
    await app.close();
  }
});

test('full-body budget includes structured attachments and paginates without dropping any source', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const expected = [];
    for (let i = 0; i < 8; i++) {
      const attachment = structuredClone(fixture.contentBlocks[0].attachment);
      attachment.text = `quote-${i}-` + 'x'.repeat(1800);
      expected.push(
        messageStore.append({
          userId: 'default-user',
          catId: null,
          content: 'outer comment',
          contentBlocks: [
            { type: 'context_attachment', attachment },
            { type: 'file', url: '/uploads/notes.txt', fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 30 },
          ],
          mentions: [],
          timestamp: i + 1,
        }).id,
      );
    }
    const actual = [];
    let cursor;
    do {
      const params = new URLSearchParams({ responseMode: 'full', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const response = await app.inject({ url: `/api/callbacks/thread-context?${params}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(Buffer.byteLength(response.body) <= 24000);
      const body = response.json();
      for (const msg of body.messages) {
        assert.equal(msg.contentBlocks.length, 2);
        assert.match(msg.content, /outer comment/);
        assert.ok(msg.contentLength > 1800);
        assert.equal(msg.truncated, false);
        actual.push(msg.id);
      }
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(actual, expected);
  } finally {
    await app.close();
  }
});
