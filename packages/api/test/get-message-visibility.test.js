/**
 * #699 P1-1: get-message route must enforce visibility/permission checks
 * RED → GREEN: tests that the target message returned by GET /api/callbacks/get-message
 * is filtered by canViewMessage, userId scope, and delivery status.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    getMessages() {
      return [];
    },
  };
}

describe('GET /api/callbacks/get-message visibility', () => {
  let registry;
  let messageStore;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: createMockSocketManager(),
      threadStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: {
        submit: async (m) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...m }),
        list: async () => [],
        transition: async () => {},
      },
    });
    return app;
  }

  test('returns 404 for whisper message not visible to calling cat', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Create a whisper visible only to 'codex', not 'opus'
    const whisperMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'secret whisper',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${whisperMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 404, 'whisper not addressed to caller should be 404');
  });

  test('returns 404 for message belonging to different userId', async () => {
    const app = await createApp();
    // Invocation for user-1
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Message belongs to user-2
    const otherUserMsg = messageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'other user message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-other',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${otherUserMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 404, 'message from different user scope should be 404');
  });

  test('returns message when caller has permission', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const msg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'hello opus',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${msg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.message.id, msg.id);
    assert.equal(body.message.content, 'hello opus');
  });

  test('returns whisper when caller is in whisperTo', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const whisperMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'whisper for opus',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${whisperMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.message.id, whisperMsg.id);
  });
});
