// F117 KD-22 (Phase J, J4): when a member's output timeout fires it is stopped the way Stop stops it,
// with reason `timeout`, and only that member: its siblings in the same turn run on. The stop goes
// through the Queue's slot, keyed by the parent execution id, so a timer left over from an earlier
// execution never stops the one that took the slot after it. A timed-out member failed — its
// response, its turn execution and the Queue's aggregate say so; nobody cancelled it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.CLI_TIMEOUT_MS = '1000';

const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { createMemberTimeoutStop, MEMBER_TIMEOUT_REASON } = await import(
  '../dist/domains/cats/services/agents/invocation/member-output-timeout.js'
);
const { resolveResponseTerminal } = await import('../dist/domains/cats/services/agents/routing/response-terminal.js');
const { classifyRoutingDispatchFailure } = await import(
  '../dist/domains/routing-context/RoutingDispatchSignalContract.js'
);
const { isCliStartupTimeoutError } = await import('../dist/domains/cats/services/agents/invocation/invoke-helpers.js');

const quietLog = { info() {} };

/** A member that sends a heartbeat and then never produces output until it is stopped. */
function silentService(catId) {
  return {
    async *invoke(_prompt, options) {
      yield { type: 'status', catId, content: 'still thinking', timestamp: Date.now() };
      await new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', resolve, { once: true });
      });
    },
  };
}

/** A member that answers after `delayMs`, longer than CLI_TIMEOUT_MS would allow in silence. */
function answeringService(catId, delayMs) {
  return {
    async *invoke() {
      for (let at = 0; at < delayMs; at += 40) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: 'text', catId, content: '.', timestamp: Date.now() };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function turnExecutionStore() {
  const records = new Map();
  return {
    records,
    async createRunning(input) {
      const record = { ...input, status: 'running' };
      records.set(input.invocationId, record);
      return { outcome: 'created', record };
    },
    async transitionTerminal(invocationId, terminal) {
      const record = { ...records.get(invocationId), ...terminal };
      records.set(invocationId, record);
      return { outcome: 'transitioned', record };
    },
    async get(invocationId) {
      return records.get(invocationId) ?? null;
    },
    async bindCoveredMessageIds() {
      return { outcome: 'bound' };
    },
  };
}

function routeDeps(services, turnStore) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    toolEventLog: { append: async () => {}, updateSummary: async () => {} },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `child-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
      },
      turnExecutionStore: turnStore,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

/** A Queue execution: one slot per target under the parent execution id, routed with the stop hook. */
async function dispatch(route, targets, services) {
  const tracker = new InvocationTracker();
  const executionId = 'parent-exec-1';
  tracker.startAll('t1', targets, 'user1', executionId);
  const turnStore = turnExecutionStore();
  const events = [];
  for await (const event of route(routeDeps(services, turnStore), targets, 'msg', 'user1', 't1', {
    signalForCat: (catId) => tracker.getController('t1', catId)?.signal,
    parentInvocationId: executionId,
    stopMember: createMemberTimeoutStop({
      invocationTracker: tracker,
      threadId: 't1',
      ownerUserId: 'user1',
      log: quietLog,
    }),
  })) {
    events.push(event);
  }
  const terminalOf = (catId) => [...turnStore.records.values()].find((record) => record.catId === catId);
  return { tracker, events, terminalOf };
}

function assertTimedOutMember(result, catId) {
  assert.equal(result.tracker.isTimedOut('t1', catId), true, `${catId} was stopped with reason timeout`);
  const failure = result.events.find((event) => event.type === 'error' && event.catId === catId);
  assert.ok(failure, `${catId}'s route reports the timeout`);
  assert.match(failure.error, /响应超时/);
  assert.ok(failure.metadata.timeoutDiagnostics.silenceDurationMs >= 1000, 'diagnostics kept from before the stop');
  // Like a provider failure, the member ends with a done that names why, after its failure: the
  // Queue settles the entry failed from it instead of throwing and broadcasting a second error row.
  const events = result.events.filter((event) => event.catId === catId);
  const done = events.findLast((event) => event.type === 'done');
  assert.ok(done, `${catId}'s route ends it with a done`);
  assert.equal(done.errorCode, MEMBER_TIMEOUT_REASON, 'the done names the timeout');
  assert.ok(events.indexOf(failure) < events.indexOf(done), 'the failure is reported before the done');
  const terminal = result.terminalOf(catId);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.terminalReason, MEMBER_TIMEOUT_REASON);
  assert.equal(terminal.parentInvocationId, 'parent-exec-1', 'the timer keyed the stop by the parent execution');
  assert.notEqual(terminal.invocationId, terminal.parentInvocationId, 'while the member ran as its own child turn');
}

function assertFinishedMember(result, catId) {
  assert.equal(result.tracker.getSlotState('t1', catId), 'active', `${catId} was not stopped`);
  assert.equal(result.tracker.getController('t1', catId).signal.aborted, false);
  assert.equal(
    result.events.some((event) => event.type === 'error' && event.catId === catId),
    false,
  );
  assert.equal(result.terminalOf(catId).status, 'succeeded');
}

describe('F117 J4: a timed-out member is stopped like Stop, alone', () => {
  it('parallel: stops the silent member and lets its sibling finish', async () => {
    const result = await dispatch(routeParallel, ['opus', 'codex'], {
      opus: silentService('opus'),
      codex: answeringService('codex', 1600),
    });
    assertTimedOutMember(result, 'opus');
    assertFinishedMember(result, 'codex');
    const opusEvents = result.events.filter((event) => event.catId === 'opus').map((event) => event.type);
    assert.ok(opusEvents.indexOf('error') < opusEvents.lastIndexOf('done'), 'the failure is reported before its done');
  });

  it('serial: stops the silent member, then runs the next one', async () => {
    const result = await dispatch(routeSerial, ['opus', 'codex'], {
      opus: silentService('opus'),
      codex: answeringService('codex', 600),
    });
    assertTimedOutMember(result, 'opus');
    assertFinishedMember(result, 'codex');
  });
});

describe('F117 J4: the Queue stop for a member timeout', () => {
  it('stops only the execution that armed the timer, never the one that took the slot after it', () => {
    const tracker = new InvocationTracker();
    const earlier = tracker.start('t1', 'opus', 'user1', ['opus'], 'exec-earlier');
    tracker.complete('t1', 'opus', earlier);
    const current = tracker.start('t1', 'opus', 'user1', ['opus'], 'exec-current');
    const stop = createMemberTimeoutStop({
      invocationTracker: tracker,
      threadId: 't1',
      ownerUserId: 'user1',
      log: quietLog,
    });

    assert.equal(stop('opus', 'exec-earlier'), false);
    assert.equal(current.signal.aborted, false, 'a leftover timer leaves the new execution alone');

    assert.equal(stop('opus', 'exec-current'), true);
    assert.equal(current.signal.reason, MEMBER_TIMEOUT_REASON);
    assert.equal(tracker.isTimedOut('t1', 'opus'), true);
  });

  it('counts a timed-out member as failed, not as cancelled by the user', () => {
    const timedOut = new InvocationTracker();
    timedOut.start('t1', 'opus', 'user1', ['opus'], 'exec-1');
    createMemberTimeoutStop({ invocationTracker: timedOut, threadId: 't1', ownerUserId: 'user1', log: quietLog })(
      'opus',
      'exec-1',
    );
    assert.equal(timedOut.resolveFinalStatus('t1', ['opus'], { aborted: false }), 'succeeded', 'outcomes decide');

    const stopped = new InvocationTracker();
    stopped.start('t1', 'opus', 'user1', ['opus'], 'exec-1');
    stopped.cancel('t1', 'opus', 'user1', 'user_cancel');
    assert.equal(stopped.isTimedOut('t1', 'opus'), false);
    assert.equal(stopped.resolveFinalStatus('t1', ['opus'], { aborted: false }), 'canceled_by_user');
  });
});

describe('F117 J4: how a stopped member ends', () => {
  it('a timeout is a failure with reason timeout; a Stop cancels; other stops interrupt', () => {
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'timeout', failed: false }), {
      status: 'failed',
      reason: 'timeout',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'user_cancel', failed: false }), {
      status: 'canceled',
      reason: 'user_cancel',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'preempted', failed: true }), {
      status: 'interrupted',
      reason: 'preempted',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: true }), {
      status: 'failed',
      reason: 'provider_error',
    });
    assert.deepEqual(
      resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: false, outputCommitRejected: true }),
      { status: 'interrupted', reason: 'output_commit_rejected' },
    );
    assert.deepEqual(resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: false }), {
      status: 'completed',
    });
  });

  it('routing counts a member timeout as a provider timeout', () => {
    assert.equal(classifyRoutingDispatchFailure({ terminalReason: 'timeout' }), 'provider_timeout');
  });

  it('keeps the session-resume retry for a CLI that never came up, not for silence after it did', () => {
    assert.equal(isCliStartupTimeoutError('布偶猫 CLI 响应超时 (30s, 未收到首帧)'), true);
    assert.equal(isCliStartupTimeoutError('布偶猫 CLI 响应超时 (1800s)'), false);
  });
});
