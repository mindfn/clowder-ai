/**
 * F150: Frontend-Facing Guide Action Routes Tests
 * POST /api/guide-actions/start  — start guide via frontend click
 * POST /api/guide-actions/cancel — cancel guide via frontend click
 *
 * These endpoints use userId-based auth (X-Cat-Cafe-User header),
 * NOT MCP callback auth. They verify the frontend-only interaction path.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('F150 Guide Action Routes (frontend-facing)', () => {
  let threadStore;
  let socketManager;
  let broadcastCalls;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
    broadcastCalls = [];
    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom(room, event, data) {
        broadcastCalls.push({ room, event, data });
      },
      getMessages() {
        return [];
      },
    };
  });

  async function createApp() {
    const { guideActionRoutes } = await import('../dist/routes/guide-action-routes.js');
    const app = Fastify();
    await app.register(guideActionRoutes, { threadStore, socketManager });
    return app;
  }

  /** Seed a thread with guideState in given status */
  async function seedThread(guideId, status, createdBy = 'user-1') {
    const thread = await threadStore.create(createdBy, 'test-thread');
    await threadStore.updateGuideState(thread.id, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
    });
    return thread;
  }

  // --- /api/guide-actions/start ---

  test('start: transitions offered → active and emits socket event', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'active');
    assert.ok(body.guideState.startedAt);

    // Verify socket event
    assert.equal(broadcastCalls.length, 1);
    assert.equal(broadcastCalls[0].event, 'guide_start');
    assert.equal(broadcastCalls[0].data.guideId, 'add-member');
  });

  test('start: transitions awaiting_choice → active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'awaiting_choice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'active');
  });

  test('start: rejects when guide is already active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('start: rejects when no guide offered', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'guide_not_offered');
  });

  test('start: rejects without user identity', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  // --- /api/guide-actions/cancel ---

  test('cancel: transitions offered → cancelled', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'cancelled');
    assert.ok(body.guideState.completedAt);
  });

  test('cancel: idempotent when already cancelled', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'cancelled');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'cancelled');
  });

  test('cancel: rejects when guide not offered', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('cancel: rejects without user identity', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  // --- P1: start must reject when flow is not loadable ---

  test('start: rejects when guide flow is not loadable (400)', async () => {
    const app = await createApp();
    // Seed thread with a guideId that has no corresponding flow YAML
    const thread = await seedThread('nonexistent-flow', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'nonexistent-flow' },
    });

    assert.equal(res.statusCode, 400, 'start must fail when flow cannot be loaded');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'guide_flow_invalid');
    // Verify state was NOT updated to active
    const updated = await threadStore.get(thread.id);
    assert.equal(updated.guideState.status, 'offered', 'state must remain offered on flow load failure');
  });

  // --- P1-1: Thread ownership (cross-user state tampering) ---

  test('start: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered'); // created by user-1

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user start must be rejected');
  });

  test('cancel: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered'); // created by user-1

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user cancel must be rejected');
  });

  // --- P2-1: Header-only auth (query param userId spoofing) ---

  test('start: rejects query-param userId without header (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: `/api/guide-actions/start?userId=user-1`,
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401, 'query-param userId must not authenticate');
  });

  test('cancel: rejects query-param userId without header (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: `/api/guide-actions/cancel?userId=user-1`,
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401, 'query-param userId must not authenticate');
  });

  // --- Default thread (createdBy='system') public access ---

  test('start: allows any authenticated user on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'system thread must allow any authenticated user');
    assert.equal(JSON.parse(res.body).guideState.status, 'active');
  });

  test('cancel: allows any authenticated user on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'system thread must allow any authenticated user');
    assert.equal(JSON.parse(res.body).guideState.status, 'cancelled');
  });

  // --- /api/guide-actions/complete ---

  test('complete: transitions active → completed and emits socket event', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'completed');
    assert.ok(body.guideState.completedAt);

    assert.equal(broadcastCalls.length, 1);
    assert.equal(broadcastCalls[0].event, 'guide_complete');
    assert.equal(broadcastCalls[0].data.guideId, 'add-member');
  });

  test('complete: idempotent when already completed', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'completed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'completed');
  });

  test('complete: rejects when guide not active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('complete: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user complete must be rejected');
  });

  test('complete: rejects without user identity (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  test('complete: allows any authenticated user on system-owned thread', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'completed');
  });
});
