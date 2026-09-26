// F117 Phase M (roadmap Phase 3): an appended input is read when the model consumed it, not when the
// carrier accepted it. The Claude SDK carrier reports that moment on the accepted dispatch result.
// Event shapes follow SDK 0.3.280 as recorded by f117-notes/phase3-read-semantics/exp-fold.mjs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const PENDING = Symbol('pending');

/** Let the carrier loop drain what it was given, then read the promise without waiting on it. */
async function peek(promise) {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return Promise.race([promise, Promise.resolve(PENDING)]);
}

async function startRun(sessionId) {
  const events = new AsyncInbox();
  const registration = {
    invocationId: `inv-${sessionId}`,
    dispatcher: undefined,
    register(dispatcher) {
      this.dispatcher = dispatcher;
      return () => {};
    },
  };
  let sdkInput;
  const service = new ClaudeSdkAgentService({
    catId: 'opus',
    model: 'claude-test',
    l0CompilerFn: async () => 'compiled L0',
    queryFn: ({ prompt }) => {
      sdkInput = prompt[Symbol.asyncIterator]();
      return {
        interrupt: async () => {},
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      };
    },
  });
  const output = service
    .invoke('initial body', {
      invocationId: registration.invocationId,
      activeRunDispatch: registration,
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    })
    [Symbol.asyncIterator]();
  const initialized = output.next();
  while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
  const initialInput = (await sdkInput.next()).value;
  events.push({ type: 'system', subtype: 'init', session_id: sessionId });
  assert.equal((await initialized).value.type, 'session_init');

  const append = async (text) => {
    const result = await registration.dispatcher.dispatch(
      { text, messageIds: [`msg-${text}`] },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.equal(result.accepted, true);
    const input = (await sdkInput.next()).value;
    return { result, input };
  };
  // Keep one read of the output pending so the carrier loop consumes pushed events.
  const drain = output.next();
  return { events, output, drain, initialInput, append };
}

async function finish(run) {
  for (let next = await run.drain; !next.done; next = await run.output.next()) {
    if (next.value.type === 'done') return;
  }
}

describe('F117 Phase M: Claude SDK reports when the model read an appended input', () => {
  it('is read at the first model frame after the engine started it, not at acceptance or start', async () => {
    const run = await startRun('sdk-read-started');
    const { result, input } = await run.append('fold me in');
    assert.ok(result.consumption instanceof Promise, 'an accepted Append carries its consumption report');
    assert.equal(await peek(result.consumption), PENDING, 'acceptance is not consumption');

    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued', uuid: 'cl-1' });
    assert.equal(await peek(result.consumption), PENDING, 'the engine queueing it is not consumption');
    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'started', uuid: 'cl-2' });
    assert.equal(await peek(result.consumption), PENDING, 'started only says the next API call carries it');

    run.events.push({
      type: 'stream_event',
      session_id: 'sdk-read-started',
      parent_tool_use_id: 'toolu_subagent',
      event: { type: 'message_start', message: { id: 'subagent-turn' } },
    });
    run.events.push({ type: 'stream_event', session_id: 'sdk-read-started', event: { type: 'ping' } });
    assert.equal(await peek(result.consumption), PENDING, 'a subagent frame or a ping proves nothing');

    const before = Date.now();
    run.events.push({
      type: 'stream_event',
      session_id: 'sdk-read-started',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'main-turn-after-fold' } },
    });
    const consumption = await peek(result.consumption);
    assert.equal(consumption.consumed, true);
    assert.ok(consumption.at >= before && consumption.at <= Date.now());

    run.events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-read-started',
      user_message_uuid: run.initialInput.uuid,
      user_message_uuids: [run.initialInput.uuid, input.uuid],
      queued_turn_count: 0,
    });
    await finish(run);
  });

  it('is not read when the API call that carried it produced nothing before the query closed', async () => {
    const run = await startRun('sdk-read-aborted-call');
    const { result, input } = await run.append('carried by a call that died');
    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'started', uuid: 'cl-3' });
    run.events.push({
      type: 'assistant',
      session_id: 'sdk-read-aborted-call',
      parent_tool_use_id: null,
      error: 'server_error',
      message: { id: 'synthetic-api-error', content: [{ type: 'text', text: 'API Error' }] },
    });
    assert.equal(await peek(result.consumption), PENDING, 'a synthetic API-error frame is no proof');
    run.events.close();
    await finish(run);
    assert.deepEqual(await peek(result.consumption), { consumed: false });
  });

  it('falls back to the documented echo when no lifecycle frame names the input', async () => {
    const run = await startRun('sdk-read-echo');
    const folded = await run.append('folded before the result');
    const nextTurn = await run.append('answered by its own turn');

    run.events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-read-echo',
      user_message_uuid: run.initialInput.uuid,
      user_message_uuids: [run.initialInput.uuid, folded.input.uuid],
      queued_turn_count: 1,
    });
    assert.equal((await peek(folded.result.consumption)).consumed, true, 'the result echo proves the fold');
    assert.equal(await peek(nextTurn.result.consumption), PENDING);

    run.events.push({
      type: 'stream_event',
      session_id: 'sdk-read-echo',
      user_message_uuid: nextTurn.input.uuid,
      user_message_uuids: [nextTurn.input.uuid],
      event: { type: 'message_start', message: { id: 'turn-2' } },
    });
    const consumption = await peek(nextTurn.result.consumption);
    assert.equal(consumption.consumed, true, 'the first stamped frame of its own turn proves it');
    run.events.close();
    await finish(run);
  });

  it('does not count the echo on an error result', async () => {
    const run = await startRun('sdk-read-error-result');
    const { result, input } = await run.append('answered by a failed turn');
    run.events.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'sdk-read-error-result',
      user_message_uuid: input.uuid,
      user_message_uuids: [run.initialInput.uuid, input.uuid],
      queued_turn_count: 0,
    });
    await finish(run);
    assert.deepEqual(await peek(result.consumption), { consumed: false });
  });

  it('reports an input the query closed without ever starting as not read', async () => {
    const run = await startRun('sdk-read-never');
    const { result, input } = await run.append('never reached');
    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued', uuid: 'cl-4' });
    assert.equal(await peek(result.consumption), PENDING);
    run.events.close();
    await finish(run);
    assert.deepEqual(await peek(result.consumption), { consumed: false });
  });

  it('reports a command cancelled after it started as not read at once', async () => {
    const run = await startRun('sdk-read-cancelled');
    const { result, input } = await run.append('cancelled mid-fold');
    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'started', uuid: 'cl-5' });
    run.events.push({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'cancelled', uuid: 'cl-6' });
    assert.deepEqual(await peek(result.consumption), { consumed: false });
    run.events.close();
    await finish(run);
  });
});
