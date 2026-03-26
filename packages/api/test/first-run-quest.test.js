/**
 * F140: First-Run Quest Integration Tests
 * - Client detection endpoint
 * - Quest thread creation and state management
 * - Quest state transitions (forward-only)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('First-Run Quest Routes', () => {
  let threadStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
  });

  async function createApp() {
    const { firstRunQuestRoutes } = await import('../dist/routes/first-run-quest.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const app = Fastify();
    await app.register(firstRunQuestRoutes, { threadStore });
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage() {}, getMessages() { return []; } },
      threadStore,
      sharedBank: 'cat-cafe-shared',
    });
    return app;
  }

  test('GET /api/first-run/available-clients returns client list', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/first-run/available-clients' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.clients));
    assert.ok(body.clients.length > 0);
    // Each client has required fields
    for (const c of body.clients) {
      assert.ok(typeof c.client === 'string');
      assert.ok(typeof c.label === 'string');
      assert.ok(typeof c.cli === 'string');
      assert.ok(typeof c.installed === 'boolean');
      assert.ok(typeof c.hasApiKey === 'boolean');
    }
  });

  test('GET /api/first-run/quest returns null when no quest exists', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.quest, null);
  });

  test('POST /api/first-run/quest creates quest thread', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/first-run/quest',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'content-type': 'application/json',
      },
      payload: { firstCatId: 'opus', firstCatName: '宪宪' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.quest);
    assert.ok(body.quest.threadId);
    assert.equal(body.quest.state.v, 1);
    assert.equal(body.quest.state.phase, 'quest-1-create-first-cat');
    assert.equal(body.quest.state.firstCatId, 'opus');
    assert.equal(body.quest.state.firstCatName, '宪宪');
  });

  test('GET /api/first-run/quest finds existing quest', async () => {
    const app = await createApp();
    // Create quest first
    await app.inject({
      method: 'POST',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: { firstCatId: 'opus' },
    });
    // Now query
    const res = await app.inject({
      method: 'GET',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.quest);
    assert.equal(body.quest.state.firstCatId, 'opus');
  });

  test('POST /api/callbacks/update-quest-state advances phase', async () => {
    const app = await createApp();
    // Create quest thread
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: { firstCatId: 'opus' },
    });
    const { quest } = JSON.parse(createRes.body);

    // Advance to cat-intro
    const updateRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: {
        threadId: quest.threadId,
        phase: 'quest-2-cat-intro',
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const body = JSON.parse(updateRes.body);
    assert.equal(body.questState.phase, 'quest-2-cat-intro');
  });

  test('rejects backward phase transition', async () => {
    const app = await createApp();
    // Create quest
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: {},
    });
    const { quest } = JSON.parse(createRes.body);

    // Advance to cat-intro
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: { threadId: quest.threadId, phase: 'quest-2-cat-intro' },
    });

    // Try to go backward — should fail
    const backRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: { threadId: quest.threadId, phase: 'quest-1-create-first-cat' },
    });
    assert.equal(backRes.statusCode, 400);
    const body = JSON.parse(backRes.body);
    assert.ok(body.error.includes('Invalid quest phase transition'));
  });

  test('quest state preserves fields across updates', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: { firstCatId: 'opus', firstCatName: '宪宪' },
    });
    const { quest } = JSON.parse(createRes.body);

    // Update with second cat info
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: {
        threadId: quest.threadId,
        phase: 'quest-2-cat-intro',
        secondCatId: 'codex',
        secondCatName: '砚砚',
      },
    });

    // Verify first cat info is preserved
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/first-run/quest',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    const body = JSON.parse(getRes.body);
    assert.equal(body.quest.state.firstCatId, 'opus');
    assert.equal(body.quest.state.firstCatName, '宪宪');
    assert.equal(body.quest.state.secondCatId, 'codex');
    assert.equal(body.quest.state.secondCatName, '砚砚');
  });
});
