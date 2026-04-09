/**
 * F150: Guide engine callback route tests
 * Tests: start-guide, guide-resolve, guide-control
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('F150 Guide callback routes', () => {
  let registry;
  let messageStore;
  let threadStore;
  let socketManager;
  let broadcasts;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    broadcasts = [];

    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
      emitToUser() {},
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
    });
    return app;
  }

  function createCreds() {
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    return { invocationId, callbackToken, threadId: thread.id };
  }

  async function seedGuideState(threadId, guideId, status) {
    await threadStore.updateGuideState(threadId, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
      ...(status === 'active' ? { startedAt: Date.now() } : {}),
    });
  }

  // ─── start-guide ───

  describe('POST /api/callbacks/start-guide', () => {
    test('starts guide with valid guideId', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      await seedGuideState(threadId, 'add-member', 'offered');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.guideId, 'add-member');

      // Verify broadcast
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].event, 'guide_start');
      assert.equal(broadcasts[0].room, `thread:${threadId}`);
      assert.equal(broadcasts[0].data.guideId, 'add-member');
    });

    test('rejects unknown guideId', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'nonexistent-flow' },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'unknown_guide_id');
      assert.equal(broadcasts.length, 0);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId: 'fake', callbackToken: 'fake', guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(broadcasts.length, 0);
    });

    test('returns stale_ignored for non-latest invocation', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      // Create a newer invocation to make the first one stale
      registry.create('user-1', 'opus', threadId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'add-member' },
      });

      const body = JSON.parse(res.body);
      assert.equal(body.status, 'stale_ignored');
      assert.equal(broadcasts.length, 0);
    });
  });

  // ─── guide-resolve ───

  describe('POST /api/callbacks/guide-resolve', () => {
    test('resolves matching intent', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId, callbackToken, intent: '添加成员' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.ok(body.matches.length > 0);
      assert.equal(body.matches[0].id, 'add-member');
    });

    test('returns empty matches for unrelated intent', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId, callbackToken, intent: '天气预报' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.matches.length, 0);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId: 'fake', callbackToken: 'fake', intent: '添加' },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ─── guide-control ───

  describe('POST /api/callbacks/guide-control', () => {
    test('broadcasts control action with valid credentials', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      await seedGuideState(threadId, 'add-member', 'active');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId, callbackToken, action: 'next' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.action, 'next');
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].event, 'guide_control');
      assert.equal(broadcasts[0].room, `thread:${threadId}`);
    });

    test('rejects invalid action', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId, callbackToken, action: 'destroy' },
      });

      assert.equal(res.statusCode, 400);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId: 'fake', callbackToken: 'fake', action: 'next' },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(broadcasts.length, 0);
    });
  });
});
