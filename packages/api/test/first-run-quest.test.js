/**
 * F140: First-Run Quest Integration Tests
 * - Client detection endpoint
 * - Quest thread creation and state management
 * - Quest state transitions (forward-only)
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

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
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
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
    assert.equal(body.quest.state.phase, 'quest-2-cat-intro');
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

    // Advance to task-select (quest starts at quest-2, so go forward to quest-3)
    const updateRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: {
        threadId: quest.threadId,
        phase: 'quest-3-task-select',
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const body = JSON.parse(updateRes.body);
    assert.equal(body.questState.phase, 'quest-3-task-select');
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

    // Advance to task-select (quest starts at quest-2)
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: { threadId: quest.threadId, phase: 'quest-3-task-select' },
    });

    // Try to go backward — should fail
    const backRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: { threadId: quest.threadId, phase: 'quest-2-cat-intro' },
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

    // Update with second cat info (must advance forward from quest-2)
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-quest-state',
      headers: { 'content-type': 'application/json' },
      payload: {
        threadId: quest.threadId,
        phase: 'quest-3-task-select',
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

describe('POST /api/first-run/connectivity-test', () => {
  /** @type {string | undefined} */ let savedGlobalRoot;

  function setGlobalRoot(dir) {
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = dir;
  }

  function restoreGlobalRoot() {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
  }

  async function createTestApp(fetchImpl) {
    const { firstRunQuestRoutes } = await import('../dist/routes/first-run-quest.js');
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const app = Fastify();
    await app.register(firstRunQuestRoutes, { threadStore: new ThreadStore() });
    /* fetchImpl goes to provider-profiles — connectivity-test delegates to it via app.inject() */
    await app.register(providerProfilesRoutes, {
      fetchImpl: fetchImpl ?? (async () => new Response('{}', { status: 200 })),
    });
    return app;
  }

  test('rejects unauthenticated requests with 401', async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/first-run/connectivity-test',
      headers: { 'content-type': 'application/json' },
      payload: { profileId: 'p1', clientId: 'anthropic' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().ok, false);
    await app.close();
  });

  test('rejects invalid body with 400', async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/first-run/connectivity-test',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: { clientId: 'anthropic' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().ok, false);
    await app.close();
  });

  test('returns 404 for nonexistent profile', async () => {
    const projectDir = await mkdtemp(join(homedir(), '.cat-cafe-frq-test-'));
    setGlobalRoot(projectDir);
    try {
      const app = await createTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/first-run/connectivity-test',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: { profileId: 'nonexistent-id', clientId: 'anthropic' },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().ok, false);
      await app.close();
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('probes anthropic protocol with fetchImpl and returns ok on success', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response('{"id":"msg_test"}', { status: 200 });
    };
    const projectDir = await mkdtemp(join(homedir(), '.cat-cafe-frq-test-'));
    setGlobalRoot(projectDir);
    try {
      const app = await createTestApp(fetchImpl);
      // Create a profile via provider-profiles route
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: {
          displayName: 'test-key',
          authType: 'api_key',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.test',
          apiKey: 'sk-test-123',
          setActive: false,
        },
      });
      const profileId = createRes.json().profile.id;
      assert.ok(profileId, 'profile should be created');

      const res = await app.inject({
        method: 'POST',
        url: '/api/first-run/connectivity-test',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: { profileId, clientId: 'anthropic', model: 'claude-sonnet-4-6' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      /* Model-specific probe: anthropic uses /v1/messages with the selected model */
      assert.ok(calls.some((c) => c.url.includes('/v1/messages')));
      await app.close();
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('probes openai protocol with selected model via chat/completions', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response('{"id":"chatcmpl-test"}', { status: 200 });
    };
    const projectDir = await mkdtemp(join(homedir(), '.cat-cafe-frq-test-'));
    setGlobalRoot(projectDir);
    try {
      const app = await createTestApp(fetchImpl);
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: {
          displayName: 'openai-test',
          authType: 'api_key',
          provider: 'openai',
          baseUrl: 'https://api.openai.test',
          apiKey: 'sk-openai-test',
          setActive: false,
        },
      });
      const profileId = createRes.json().profile.id;

      const res = await app.inject({
        method: 'POST',
        url: '/api/first-run/connectivity-test',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: { profileId, clientId: 'openai', model: 'gpt-4o' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().ok, true);
      /* Model-specific probe: openai uses /v1/chat/completions with the selected model */
      assert.ok(calls.some((c) => c.url.includes('/v1/chat/completions')));
      await app.close();
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('works with custom provider (openrouter) without 400 selector error', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response('{"id":"chatcmpl-or"}', { status: 200 });
    };
    const projectDir = await mkdtemp(join(homedir(), '.cat-cafe-frq-test-'));
    setGlobalRoot(projectDir);
    try {
      const app = await createTestApp(fetchImpl);
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: {
          displayName: 'openrouter-key',
          authType: 'api_key',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-test',
          setActive: false,
        },
      });
      const profileId = createRes.json().profile.id;
      assert.ok(profileId, 'openrouter profile should be created');

      const res = await app.inject({
        method: 'POST',
        url: '/api/first-run/connectivity-test',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: { profileId, clientId: 'openrouter' },
      });
      // Must NOT be 400 — previously failed with "profile not found" due to assertProviderSelector
      assert.notEqual(res.statusCode, 400, 'custom provider should not trigger selector error');
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().ok, true);
      await app.close();
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('delegates to provider-profiles test and returns error on 401', async () => {
    const fetchImpl = async () => new Response('Unauthorized', { status: 401 });
    const projectDir = await mkdtemp(join(homedir(), '.cat-cafe-frq-test-'));
    setGlobalRoot(projectDir);
    try {
      const app = await createTestApp(fetchImpl);
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: {
          displayName: 'bad-key',
          authType: 'api_key',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.test',
          apiKey: 'sk-bad',
          setActive: false,
        },
      });
      const profileId = createRes.json().profile.id;

      const res = await app.inject({
        method: 'POST',
        url: '/api/first-run/connectivity-test',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: { profileId, clientId: 'anthropic' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().ok, false);
      assert.equal(res.json().status, 401);
      await app.close();
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('tryCliProbe (unit)', () => {
  /** @param {string} stdout */
  function mockExec(stdout, shouldThrow = false, errorMsg = '') {
    return async () => {
      if (shouldThrow) throw new Error(errorMsg);
      return { stdout };
    };
  }

  test('returns null for unknown client', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('unknown-cli', { execFn: mockExec('') });
    assert.equal(result, null);
  });

  test('returns ok when CLI produces non-error output', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { execFn: mockExec('pong') });
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.ok(result.message.includes('连接正常'));
  });

  test('returns failure when stdout is empty', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { execFn: mockExec('') });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('无响应'));
  });

  test('detects error patterns in stdout as failure (false positive guard)', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('opencode', { execFn: mockExec('Error: The resource is frozen.') });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('异常'));
  });

  test('treats budget/exceeded errors as connectivity success', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { execFn: mockExec('', true, 'Exceeded USD budget (0.05)') });
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.ok(result.message.includes('受限响应'));
  });

  test('detects authentication errors', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { execFn: mockExec('', true, 'authentication required: please login') });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('OAuth'));
  });

  test('includes --model in CLI command when model is provided', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    let capturedCmd = '';
    const exec = async (cmd) => {
      capturedCmd = cmd;
      return { stdout: 'pong' };
    };
    const result = await tryCliProbe('claude', { model: 'claude-sonnet-4-6', execFn: exec });
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.ok(capturedCmd.includes('--model claude-sonnet-4-6'));
  });

  test('treats budget error in stdout (exit 0) as connectivity success', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { execFn: mockExec('Error: Exceeded USD budget (0.05)') });
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.ok(result.message.includes('受限响应'));
  });

  test('rejects model names with unsafe characters', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('claude', { model: '"; rm -rf /' });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('非法字符'));
  });

  test('reports generic CLI failures', async () => {
    const { tryCliProbe } = await import('../dist/routes/first-run-quest.js');
    const result = await tryCliProbe('gemini', { execFn: mockExec('', true, 'Not enough arguments following: p') });
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('调用失败'));
  });
});
