/**
 * Cross-thread misdelivery — attribution discriminator.
 *
 * Bug-report: docs/bug-report/ghost-thread-cross-thread-session-routing/
 *
 * Six operator-confirmed misdeliveries (2026-04-30 → 2026-09-19) were long attributed
 * to a "Ghost Thread" server bug: "cross-post 后 session continuation 可能绑错 thread".
 * A full read-only scan of the running corpus falsified that (0 undeclared cross-thread
 * continuations over 7,755 causal edges; 0 wake-binding mismatches over 663 A2A-triggered
 * sessions).
 *
 * This suite pins the invariant that makes the two failure classes distinguishable
 * WITHOUT a corpus scan:
 *
 *   SENDER-TARGET ERROR  — the message lands in the threadId the caller declared.
 *                          Server is faithful; the wrong coordinate came from the caller.
 *   SERVER ROUTING ERROR — the message (or the wake) lands somewhere the caller did not
 *                          declare. That is what these assertions would catch.
 *
 * If a future change ever reroutes a cross-post away from the declared target, or wakes
 * an invocation bound to a thread other than the declared target, these tests go red and
 * the "ghost thread" hypothesis is back on the table with evidence.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return { broadcastAgentMessage() {}, broadcastToRoom() {} };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    getRecords() {
      return records;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

function createMockThreadStore() {
  const threads = new Map();
  return {
    create(userId, title) {
      const thread = {
        id: `thread-${threads.size}`,
        userId,
        createdBy: userId,
        title: title ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      threads.set(thread.id, thread);
      return thread;
    },
    get(id) {
      return threads.get(id) ?? null;
    },
    list(userId) {
      return [...threads.values()].filter((t) => t.createdBy === userId);
    },
    listByProject(userId) {
      return this.list(userId);
    },
    getParticipants() {
      return [];
    },
    getParticipantsWithActivity() {
      return [];
    },
    addParticipants() {},
    updateParticipantActivity() {},
    updateTitle() {},
    seed(thread) {
      threads.set(thread.id, thread);
      return thread;
    },
  };
}

describe('cross-thread misdelivery — sender-target vs server-routing attribution', () => {
  let registry;
  let messageStore;
  let invocationRecordStore;
  let threadStore;

  // Real incident shape (I-1, 2026-09-19): source = the K-1/F258 main thread,
  // declared target = the A2A #1398 thread, which has nothing to do with the subject.
  const SOURCE_THREAD = 'thread_mrkmxgdfqquounc9';
  const UNRELATED_TARGET = 'thread_msr51149hym0i79f';
  const THIRD_THREAD = 'thread_mrkn6povq4zzgh45';

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    invocationRecordStore = createMockInvocationRecordStore();
    threadStore = createMockThreadStore();
    for (const [id, title] of [
      [SOURCE_THREAD, 'clowder-ai support — K-1 messaging (F258)'],
      [UNRELATED_TARGET, 'A2A Lifecycle 1398'],
      [THIRD_THREAD, 'F202 Train C1 — Plugins aggregate migration'],
    ]) {
      threadStore.seed({
        id,
        userId: 'user-1',
        createdBy: 'user-1',
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore,
      threadStore,
    });
    return app;
  }

  async function crossPost(app, { threadId, content, targetCats, clientMessageId }) {
    // InvocationRegistry.create(userId, catId, threadId) — positional string, not an options
    // object. Passing an object here would make actor.threadId an object that trivially
    // !== any target, and the cross-thread path would pass for the wrong reason.
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', SOURCE_THREAD);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId, content, targetCats, clientMessageId },
    });
    return response;
  }

  test('delivery lands in the caller-declared thread — never the actor thread, never a third thread', async () => {
    const app = await createApp();
    const response = await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'F167 behavioral evidence candidate\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-1',
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json().threadId,
      UNRELATED_TARGET,
      'server must echo the caller-declared target, not silently reroute',
    );

    const landed = messageStore.getByThread(UNRELATED_TARGET, 10, 'user-1');
    assert.equal(landed.length, 1, 'exactly one message in the declared target');
    assert.equal(messageStore.getByThread(SOURCE_THREAD, 10, 'user-1').length, 0, 'nothing written back to source');
    assert.equal(messageStore.getByThread(THIRD_THREAD, 10, 'user-1').length, 0, 'nothing leaked to a third thread');
  });

  test('delivered message carries complete source provenance, so misdelivery is attributable', async () => {
    const app = await createApp();
    await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'F167 behavioral evidence candidate\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-2',
    });

    const [landed] = messageStore.getByThread(UNRELATED_TARGET, 10, 'user-1');
    assert.equal(
      landed.extra?.crossPost?.sourceThreadId,
      SOURCE_THREAD,
      'source thread must be recorded on the delivered message — without it no misdelivery can be attributed',
    );
    assert.notEqual(
      landed.extra.crossPost.sourceThreadId,
      landed.threadId,
      'provenance must record a real cross-thread edge',
    );
  });

  test('the woken invocation is bound to the declared target thread, not the actor thread', async () => {
    const app = await createApp();
    await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'F167 behavioral evidence candidate\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-3',
    });

    const records = invocationRecordStore.getRecords();
    assert.equal(records.length, 1, `expected exactly one wake record, got ${JSON.stringify(records)}`);
    assert.equal(
      records[0].threadId,
      UNRELATED_TARGET,
      'the wake follows the declared target — "the cat from the next thread answered" is a consequence of the declared coordinate, not of continuation drift',
    );
  });

  // The wake test above proves the FIRST hop binds to the declared target. On its own it
  // cannot support the claim that a continuation mis-binding would go red: the woken cat
  // had not yet spoken. This test closes that gap by letting the woken invocation emit its
  // default reply (no explicit threadId — the overwhelmingly common case) and pinning where
  // it lands.
  //
  // The continuation invocation is deliberately created from the OBSERVED wake record rather
  // than from a hardcoded constant, so a drifted wake binding cannot be masked here: if the
  // wake ever bound to the source thread, the default reply would follow it there and the
  // final assertions fail.
  test('the woken cat default reply continues in its own bound thread, not the source thread', async () => {
    const app = await createApp();
    await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'F167 behavioral evidence candidate\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-5',
    });

    const [wake] = invocationRecordStore.getRecords();
    assert.ok(wake, 'the cross-post must have produced a wake record to continue from');

    // Simulates the runtime spawning the woken cat against the thread the wake bound to.
    const woken = await registry.create('user-1', 'codex', wake.threadId);
    const continuation = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': woken.invocationId, 'x-callback-token': woken.callbackToken },
      // No threadId: the default continuation path, which resolves to the actor's bound thread.
      payload: { content: 'continuation reply from the woken cat', clientMessageId: 'attribution-5-reply' },
    });

    assert.equal(continuation.statusCode, 200, continuation.body);
    assert.equal(
      continuation.json().threadId,
      UNRELATED_TARGET,
      'a default continuation must stay in the thread the wake bound to — drifting to another thread IS the ghost-thread hypothesis',
    );

    const sourceMessages = messageStore.getByThread(SOURCE_THREAD, 10, 'user-1');
    assert.equal(
      sourceMessages.length,
      0,
      `continuation must not leak back into the source thread, got ${JSON.stringify(sourceMessages.map((m) => m.content))}`,
    );
    assert.equal(
      messageStore.getByThread(THIRD_THREAD, 10, 'user-1').length,
      0,
      'continuation must not leak into an unrelated third thread',
    );
    assert.equal(
      messageStore.getByThread(UNRELATED_TARGET, 10, 'user-1').length,
      2,
      'the delivered cross-post and the continuation reply both belong to the declared target',
    );
  });

  // CHARACTERIZATION (not an endorsement): documents root cause R-1 — the server has no
  // source→target semantic fence. Changing this behavior is an intentional policy decision
  // (Decision Packet, 取舍 1); if this test goes red, that decision was made and the
  // bug-report + skill guidance must be updated in the same change.
  //
  // Scope note: this pins ONLY that delivery is accepted. It deliberately does NOT assert the
  // absence of a grounding/receipt field — adding a non-blocking receipt is an observability
  // improvement that must stay possible without tripping a policy characterization.
  test('CHARACTERIZATION: a semantically unrelated target is accepted with no subject fence', async () => {
    const app = await createApp();
    const response = await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'subject the target thread has never seen\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-4',
    });

    assert.equal(response.statusCode, 200, 'today: existence + principal scope are the ONLY target checks');
    assert.equal(
      messageStore.getByThread(UNRELATED_TARGET, 10, 'user-1').length,
      1,
      'acceptance means the message is actually delivered, not merely acknowledged',
    );
  });

  // TODO(decision-packet R-1): when/if the operator adopts a source→target grounding contract,
  // this is the shape that replaces the characterization above — the caller declares HOW it
  // resolved the target, and an unresolvable declaration is refused rather than delivered.
  // Left as an explicit skip so the intended contract stays visible in the suite instead of
  // living only in prose.
  test.skip('FUTURE(R-1): an ungrounded target declaration is refused', async () => {
    const app = await createApp();
    const response = await crossPost(app, {
      threadId: UNRELATED_TARGET,
      content: 'subject the target thread has never seen\n@codex',
      targetCats: ['codex'],
      clientMessageId: 'attribution-6',
    });
    assert.equal(response.statusCode, 400, 'a target the caller cannot justify must not be delivered silently');
  });
});
