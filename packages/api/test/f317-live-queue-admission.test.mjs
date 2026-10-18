import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.ts';
import { createCanonicalLiveSourceFixture } from './helpers/1398-live-source-fixture.mjs';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.ok(check(), 'expected lifecycle transition');
}

test(
  'real Live call publishes Queue readiness only after preparing, ready and connecting finish',
  { timeout: 5000 },
  async () => {
    const binding = Promise.withResolvers();
    const connecting = Promise.withResolvers();
    const q = await createCanonicalLiveSourceFixture(
      { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
      'agent',
      {
        targetCats: ['codex-astra'],
        router: {
          resolveConversationTargetsAtAdmission: async (targets) => [...targets],
          resolveExplicitTargets: async (targets) => [...targets],
          async *routeExecution() {
            throw new Error('startup input must append to the current Live invocation');
          },
        },
      },
    );
    const call = await LiveCompanionCall.create({
      binding: { userId: 'owner', threadId: 'home', catId: 'codex-astra', callId: 'queue-startup' },
      messageStore: q.store,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => {
        await binding.promise;
        return true;
      },
      publish() {},
    });
    const config = await call.configure({
      CAT_CAFE_API_URL: 'http://localhost:3012',
      CAT_CAFE_USER_ID: 'owner',
      CAT_CAFE_THREAD_ID: 'home',
      CAT_CAFE_CAT_ID: 'codex-astra',
      CAT_CAFE_INVOCATION_ID: q.auth.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: 'synthetic',
    });
    const f = wireFixture({ observeInputRead: true });
    const write = f.wire.write;
    f.wire.write = async (row) => {
      if (row.method === 'thread/realtime/start' || row.method === 'thread/realtime/stop') {
        f.writes.push(row);
        f.push({ id: row.id, result: {} });
        if (row.method.endsWith('/start')) connecting.resolve();
        else f.push({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      } else await write(row);
    };
    let readyCount = 0;
    const completions = [];
    const run = (async () => {
      for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
        thread: { kind: 'start' },
        prompt: { kind: 'frozen', prompt: 'bootstrap' },
        config,
        live: call,
        activeRunDispatch: {
          invocationId: q.auth.invocationId,
          register: (value) => {
            readyCount++;
            const release = q.tracker.bindAgentClientActiveRunDispatcher('home', 'codex-astra', value, 'live-parent');
            assert.ok(release);
            void q.processor.requestDrain('home');
            return release;
          },
        },
      }))
        if (event.type === 'app_server.live_turn_completed') completions.push(event.turnId);
    })();
    void run.catch(() => {});
    try {
      await eventually(() => f.writes.some((row) => row.method === 'turn/start'));
      assert.equal(call.status().state, 'preparing');
      assert.equal(readyCount, 0, 'Queue must not receive an unusable dispatcher while preparing');
      await q.processor.requestDrain('home');
      assert.deepEqual((await q.queue.getDurableEntry('home', q.entry.id)).targets, ['codex-astra']);
      binding.resolve();
      await call.initialized.promise;
      assert.equal(call.status().state, 'ready');
      assert.equal(readyCount, 0);
      const start = call.start('synthetic-offer');
      await connecting.promise;
      assert.equal(call.status().state, 'connecting');
      assert.equal(readyCount, 0);
      f.push({ method: 'thread/realtime/started', params: { threadId: 'native', realtimeSessionId: 'rtc' } });
      f.push({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      assert.equal(await start, 'answer');
      await eventually(() => readyCount === 1);
      assert.equal(call.acceptsInput(), true);
      await eventually(() => q.store.getById(q.message.id).lifecycle.dispatchRefs?.length === 1);
      await eventually(() => completions.includes('turn-2'));
      const ref = q.store.getById(q.message.id).lifecycle.dispatchRefs[0];
      assert.equal(ref.statusMessageId, q.response.id);
      assert.ok(
        f.writes.some(
          (row) =>
            row.method === 'turn/start' && row.params.input.some((item) => item.text?.includes('actual queued body')),
        ),
      );
      assert.equal(readyCount, 1);
    } finally {
      binding.resolve();
      await call.stop().catch(() => {});
      await run.catch(() => {});
      await q.close();
    }
  },
);

for (const phase of ['enqueued', 'recording']) {
  test(`Live closure during ${phase} but before handoff is definitely not accepted`, { timeout: 3000 }, async () => {
    const f = wireFixture();
    const done = Promise.withResolvers();
    let dispatcher;
    let inputOpen = true;
    let result;
    const outcomes = [];
    const prepare = (text) => ({
      v: 1,
      message: { body: text },
      nativeInstructions: [],
      runtime: {},
      tools: {},
      providerNativeVisibility: 'unknown',
    });
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'bootstrap' },
      prepareRequest: prepare,
      prepareLiveRequest: (value) => prepare(value.text),
      beforeProviderLaunch: async (request) => {
        if (phase === 'recording' && request.message.body === 'not handed off') inputOpen = false;
        return { requestGenerationId: request.message.body, generationOrdinal: 1, sessionId: 'session' };
      },
      onLiveInputOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      activeRunDispatch: {
        invocationId: 'live-invocation',
        register: (value) => {
          dispatcher = value;
        },
      },
      live: { finished: done.promise, ready: async () => {}, observe: async () => {}, acceptsInput: () => inputOpen },
    })) {
      if (event.type !== 'app_server.live_turn_completed') continue;
      const submission = dispatcher.dispatch(
        { text: 'not handed off', messageIds: ['unsent'], deliveryId: 'unsent' },
        { expectedInvocationId: 'live-invocation', force: false },
      );
      if (phase === 'enqueued') inputOpen = false;
      void submission.then((value) => {
        result = value;
        done.resolve();
      });
    }
    assert.equal(result.accepted, false);
    assert.equal(result.acceptance, 'not_accepted');
    if (phase === 'recording')
      assert.deepEqual(
        outcomes.map((value) => value.outcome),
        ['cancelled'],
      );
    assert.equal(f.writes.filter((row) => row.method === 'turn/start').length, 1);
    assert.equal(
      f.writes.some((row) => row.method === 'turn/steer'),
      false,
    );
  });
}
