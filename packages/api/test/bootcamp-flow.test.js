/**
 * Bootcamp Flow Integration Test
 * Full happy path: create thread → advance through phases → complete
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('Bootcamp Flow Integration', () => {
  let registry;
  let threadStore;
  let messageStore;
  let socketManager;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    socketManager = {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { bootcampRoutes } = await import('../dist/routes/bootcamp.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const { leaderboardEventsRoutes } = await import('../dist/routes/leaderboard-events.js');
    const { AchievementStore } = await import('../dist/domains/leaderboard/achievement-store.js');
    const { GameStore } = await import('../dist/domains/leaderboard/game-store.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
    });
    await app.register(bootcampRoutes, { threadStore });
    await app.register(threadsRoutes, { threadStore });
    await app.register(leaderboardEventsRoutes, {
      gameStore: new GameStore(),
      achievementStore: new AchievementStore(),
    });
    return app;
  }

  test('full bootcamp lifecycle: wizard seed → intro → env → first-project → add-teammate → graduate', async () => {
    const app = await createApp();

    // Step 1: Wizard creates thread at phase-0 (cat selection done by wizard)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        title: '🎓 猫猫训练营',
        bootcampState: {
          v: 1,
          phase: 'phase-0-select-cat',
          leadCat: 'opus',
          startedAt: 1000,
        },
      },
    });

    assert.equal(createRes.statusCode, 201);
    const thread = JSON.parse(createRes.body);
    assert.ok(thread.id);
    assert.equal(thread.bootcampState.phase, 'phase-0-select-cat');

    // Helper: advance phase (creates fresh invocation each time, simulating multiple turns)
    async function advancePhase(threadId, phase, extra = {}) {
      const creds = registry.create('user-1', 'opus', threadId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-bootcamp-state',
        payload: { invocationId: creds.invocationId, callbackToken: creds.callbackToken, threadId, phase, ...extra },
      });
      assert.equal(res.statusCode, 200, `Phase ${phase} should succeed`);
      return JSON.parse(res.body);
    }

    // Step 2: Cat starts → advance to phase-1-intro (fires enrolled achievement)
    const s2 = await advancePhase(thread.id, 'phase-1-intro');
    assert.equal(s2.bootcampState.phase, 'phase-1-intro');
    assert.equal(s2.bootcampState.leadCat, 'opus');

    // Step 3: Intro done → env check
    await advancePhase(thread.id, 'phase-2-env-check');

    // Step 3b: Run env check → auto-stores results
    const envCreds = registry.create('user-1', 'opus', thread.id);
    const step3 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      payload: { invocationId: envCreds.invocationId, callbackToken: envCreds.callbackToken, threadId: thread.id },
    });
    assert.equal(step3.statusCode, 200);
    assert.ok('node' in JSON.parse(step3.body));
    const afterEnv = await threadStore.get(thread.id);
    assert.ok(afterEnv.bootcampState.envCheck);

    // Step 4: Env OK → skip phase-3, jump directly to phase-4-first-project (allowed skip)
    const s4 = await advancePhase(thread.id, 'phase-4-first-project');
    assert.equal(s4.bootcampState.phase, 'phase-4-first-project');
    assert.equal(s4.bootcampState.leadCat, 'opus'); // preserved

    // Step 5: First project done (deliberately flawed) → add teammate
    const s5 = await advancePhase(thread.id, 'phase-4.5-add-teammate', {
      guideStep: 'open-hub',
    });
    assert.equal(s5.bootcampState.phase, 'phase-4.5-add-teammate');
    assert.equal(s5.bootcampState.guideStep, 'open-hub');

    // Step 6: Teammate added → graduation shortcut to phase-11 (skip phases 5-10)
    const completedAt = Date.now();
    const s6 = await advancePhase(thread.id, 'phase-11-farewell', { completedAt, guideStep: null });
    assert.equal(s6.bootcampState.phase, 'phase-11-farewell');
    assert.equal(s6.bootcampState.completedAt, completedAt);
    assert.equal(s6.bootcampState.leadCat, 'opus');
    assert.equal(s6.bootcampState.startedAt, 1000);
    assert.ok(s6.bootcampState.envCheck);

    // Verify thread was auto-pinned on farewell
    const finalThread = await threadStore.get(thread.id);
    assert.equal(finalThread.pinned, true, 'Thread should be auto-pinned after farewell');
  });
});
