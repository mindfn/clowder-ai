import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function quote(text = '原始引用 QUOTE_NEEDLE', comment = '用户评论 COMMENT_NEEDLE') {
  return {
    type: 'context_attachment',
    attachment: {
      v: 1,
      id: 'quote-test',
      kind: 'quote',
      text,
      comment,
      selectionStart: 3,
      selectionEnd: 3 + text.length,
      source: { kind: 'cli_output', threadId: 'source-thread', messageId: 'source-message', segmentId: 'stdout' },
    },
  };
}

describe('G3 callback quote projection (real routes, isolated memory stores)', () => {
  let app, store, threads, headers, thread;
  let queue, invocationId;
  beforeEach(async () => {
    const registry = new InvocationRegistry();
    store = new MessageStore();
    threads = new ThreadStore();
    thread = threads.create('user-1', 'quote projection');
    const auth = await registry.create('user-1', 'opus', thread.id);
    invocationId = auth.invocationId;
    queue = new InvocationQueue();
    headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: store,
      threadStore: threads,
      invocationQueue: queue,
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async (m) => ({ id: 'marker', ...m }), list: async () => [], transition: async () => {} },
    });
  });
  afterEach(async () => app.close());
  function append(overrides = {}) {
    return store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        threadId: thread.id,
        content: '',
        contentBlocks: [quote()],
        mentions: [],
        timestamp: Date.now(),
        ...overrides,
      }),
    );
  }
  async function read(path) {
    const response = await app.inject({ method: 'GET', url: `/api/callbacks/${path}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return { body: response.json(), bytes: Buffer.byteLength(response.body, 'utf8') };
  }

  test('get-message preview and thread anchor expose quote and paired comment instead of an empty body', async () => {
    const original = append();
    const single = (await read(`get-message?messageId=${original.id}`)).body.message;
    assert.match(single.content, /QUOTE_NEEDLE/);
    assert.match(single.content, /COMMENT_NEEDLE/);
    assert.ok(single.contentLength > 0);
    assert.equal(single.contentBlocks, undefined);
    assert.equal(single.drillDown.args.messageId, original.id);
    const anchor = (await read('thread-context')).body.messages.find((m) => m.id === original.id);
    assert.match(anchor.preview, /QUOTE_NEEDLE/);
    assert.match(anchor.preview, /COMMENT_NEEDLE/);
    assert.ok(anchor.contentLength > 0);
    assert.equal(anchor.contentBlocks, undefined);
    assert.equal((await store.getById(original.id)).content, '', 'projection never rewrites canonical storage');
  });

  test('full reads retain raw content, all quote provenance and selection offsets', async () => {
    const original = append();
    const single = (await read(`get-message?messageId=${original.id}&mode=full`)).body.message;
    const full = (await read('thread-context?responseMode=full')).body.messages.find((m) => m.id === original.id);
    for (const message of [single, full]) {
      assert.equal(message.content, '');
      assert.deepEqual(message.contentBlocks, original.contentBlocks);
      assert.equal(message.truncated, false);
    }
  });

  for (const length of [280, 12000]) {
    test(`a ${length}-character quote cannot displace the user's comment from default previews`, async () => {
      const original = append({ contentBlocks: [quote('中'.repeat(length), '用户要求 F1_ACTION')] });
      const single = (await read(`get-message?messageId=${original.id}`)).body.message;
      const anchor = (await read('thread-context')).body.messages.find((m) => m.id === original.id);
      for (const preview of [single.content, anchor.preview]) {
        assert.match(preview, /\[评论\]\n用户要求 F1_ACTION/);
        assert.match(preview, /\[引用\]/);
        assert.ok(preview.length <= 280);
      }
      assert.equal(single.truncated, true);
      assert.equal(anchor.truncated, true);
      assert.equal(single.contentLength, anchor.contentLength);
      const full = (await read(`get-message?messageId=${single.drillDown.args.messageId}&mode=full`)).body.message;
      assert.equal(full.content, original.content);
      assert.deepEqual(full.contentBlocks, original.contentBlocks);
      for (const keyword of ['F1_ACTION', '中']) {
        const result = await read(`thread-context?keyword=${encodeURIComponent(keyword)}`);
        assert.equal(result.body.messages[0].id, original.id);
        assert.ok(result.body.messages[0].preview.includes(keyword));
      }
    });
  }

  test('a quote without a comment keeps its quote-first preview and does not invent a comment', async () => {
    const block = quote('NO_COMMENT_QUOTE');
    delete block.attachment.comment;
    const original = append({ contentBlocks: [block] });
    const single = (await read(`get-message?messageId=${original.id}`)).body.message;
    assert.equal(single.content, '[引用]\nNO_COMMENT_QUOTE');
    assert.equal(single.truncated, false);
  });

  test('mixed body and multiple quotes stay distinct; plain/text blocks are not duplicated', async () => {
    const blocks = [{ type: 'text', text: 'ordinary body' }, quote(), quote('second quote', 'second comment')];
    const original = append({ content: 'ordinary body', contentBlocks: blocks });
    const preview = (await read(`get-message?messageId=${original.id}`)).body.message;
    assert.equal(preview.content.split('ordinary body').length - 1, 1);
    assert.match(preview.content, /QUOTE_NEEDLE/);
    assert.match(preview.content, /second quote/);
    const full = (await read('thread-context?responseMode=full')).body.messages.find((m) => m.id === original.id);
    assert.deepEqual(full.contentBlocks, blocks);
  });

  for (const keyword of ['QUOTE_NEEDLE', 'COMMENT_NEEDLE']) {
    test(`keyword search includes attachment-only ${keyword} and shows the matching excerpt`, async () => {
      const original = append({ contentBlocks: [quote('x'.repeat(700) + ' QUOTE_NEEDLE', 'COMMENT_NEEDLE')] });
      const response = await read(`thread-context?keyword=${keyword}`);
      assert.deepEqual(
        response.body.messages.map((m) => m.id),
        [original.id],
      );
      assert.match(response.body.messages[0].preview, new RegExp(keyword));
      assert.equal(response.body.messages[0].truncated, true);
    });
  }

  test('large quote blocks participate in byte budget; oversized item remains a drillable anchor', async () => {
    const original = append({ contentBlocks: [quote('中'.repeat(12000), 'keep comment')] });
    const response = await read('thread-context?responseMode=full');
    assert.ok(response.bytes <= 24000);
    const message = response.body.messages.find((m) => m.id === original.id);
    assert.equal(message.oversized, true);
    assert.equal(message.truncated, true);
    assert.equal(message.contentBlocks, undefined);
    assert.equal(message.drillDown.args.messageId, original.id);
    const drill = (await read(`get-message?messageId=${original.id}&mode=full`)).body.message;
    assert.deepEqual(drill.contentBlocks, original.contentBlocks);
  });

  test('quote-heavy full paging returns every record once and preserves the complete blocks', async () => {
    const originals = Array.from({ length: 8 }, (_, i) =>
      append({ timestamp: i + 1, contentBlocks: [quote(`page-${i}-${'中'.repeat(2000)}`, 'comment')] }),
    );
    const seen = [];
    let cursor;
    for (let page = 0; page < 12; page++) {
      const params = new URLSearchParams({ responseMode: 'full', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const result = await read(`thread-context?${params}`);
      assert.ok(result.bytes <= 24000);
      for (const m of result.body.messages) {
        assert.deepEqual(m.contentBlocks, originals.find((o) => o.id === m.id).contentBlocks);
        seen.push(m.id);
      }
      if (!result.body.hasMore) break;
      assert.ok(result.body.nextCursor);
      cursor = result.body.nextCursor;
    }
    assert.deepEqual(
      seen,
      originals.map((m) => m.id),
    );
  });

  test('preview remains bounded and carries an explicit full drill for a long comment', async () => {
    const original = append({ contentBlocks: [quote('short quote', 'comment'.repeat(2000))] });
    const preview = (await read(`get-message?messageId=${original.id}`)).body.message;
    assert.ok(preview.content.length <= 280);
    assert.equal(preview.truncated, true);
    assert.equal(preview.drillDown.args.mode, 'full');
  });

  for (const kind of ['quote', 'plaintext']) {
    test(`oversized queued ${kind} reports unavailable drill until publication and retains unread custody`, async () => {
      const original = append({
        content: kind === 'plaintext' ? '中'.repeat(12000) : '',
        contentBlocks: kind === 'quote' ? [quote('中'.repeat(12000))] : undefined,
        deliveryStatus: 'queued',
      });
      const queued = queue.enqueueDurableNow({
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        threadId: thread.id,
        userId: 'user-1',
        from: { kind: 'user', userId: 'user-1' },
        content: original.content,
        messageId: original.id,
        targetCats: ['opus'],
        authorIntentByCatId: { opus: { requested: 'continue_current', boundParentInvocationId: invocationId } },
        intent: 'execute',
        sourceId: 'quote-queue',
      });
      const pending = queue.getEntrySnapshot(thread.id, 'user-1', queued.entry.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await read('thread-context?responseMode=full');
        assert.ok(result.bytes <= 24000);
        const message = result.body.messages.find((m) => m.id === original.id);
        assert.equal(message.oversized, true);
        assert.equal(message.drillDown, undefined, 'unpublished persisted work cannot advertise get_message');
        assert.match(message.drillUnavailableReason, /not.*published.*retry after delivery/);
        assert.equal(message.deliveryStatus, 'queued');
        assert.equal(message.content, undefined);
        assert.equal(message.contentBlocks, undefined);
        const snapshot = queue.getEntrySnapshot(thread.id, 'user-1', queued.entry.id);
        assert.equal(snapshot.status, pending.status);
        assert.deepEqual(snapshot.delivery, pending.delivery, 'no read exposure or adoption from an anchor');
        const blocked = await app.inject({
          method: 'GET',
          url: `/api/callbacks/get-message?messageId=${original.id}&mode=full`,
          headers,
        });
        assert.equal(blocked.statusCode, 404, 'ordinary get_message publication gate stays closed');
      }
      // Once actual delivery publishes the row, follow the advertised pointer rather
      // than only checking its shape. The complete original payload must be available.
      store.markDelivered(original.id, Date.now());
      const published = (await read('thread-context?responseMode=full')).body.messages.find(
        (m) => m.id === original.id,
      );
      assert.equal(published.oversized, true);
      assert.equal(published.drillUnavailableReason, undefined);
      assert.equal(published.drillDown.tool, 'cat_cafe_get_message');
      const drillArgs = new URLSearchParams(published.drillDown.args);
      const drill = (await read(`get-message?${drillArgs}`)).body.message;
      assert.equal(drill.content, original.content);
      assert.deepEqual(drill.contentBlocks, original.contentBlocks);
    });
  }

  test('quote projection cannot expose other owners, deleted rows or play-mode whispers (including neighbors)', async () => {
    threads.updateThinkingMode(thread.id, 'play');
    const target = append({ content: 'visible', contentBlocks: undefined, timestamp: 1 });
    const hidden = [
      append({ userId: 'other-user', timestamp: 2 }),
      append({ visibility: 'whisper', whisperTo: ['codex'], timestamp: 3 }),
      append({ timestamp: 4 }),
    ];
    await store.softDelete(hidden[2].id, 'user-1');
    for (const message of hidden) {
      for (const mode of ['preview', 'full']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/callbacks/get-message?messageId=${message.id}&mode=${mode}`,
          headers,
        });
        assert.equal(res.statusCode, 404);
      }
    }
    const result = await read('thread-context?responseMode=full');
    assert.deepEqual(
      result.body.messages.map((m) => m.id),
      [target.id],
    );
    const neighbors = (await read(`get-message?messageId=${target.id}&mode=full&contextCount=10`)).body.context;
    assert.equal(neighbors.length, 0);
  });
});
