import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

test(
  'Queue dispatch follows the same Live invocation across internal root turn completions',
  { timeout: 3000 },
  async () => {
    const f = wireFixture();
    const done = Promise.withResolvers();
    const results = [];
    const errors = [];
    let dispatcher;
    let releases = 0;
    let childCompletions = 0;
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'voice bootstrap' },
      activeRunDispatch: {
        invocationId: 'live-invocation',
        register: (value) => {
          dispatcher = value;
          return () => {
            releases++;
          };
        },
      },
      live: { finished: done.promise, ready: async () => {}, observe: async () => {} },
    })) {
      if (event.type !== 'app_server.live_turn_completed') continue;
      if (++childCompletions === 3) {
        done.resolve();
        continue;
      }
      setImmediate(async () => {
        try {
          const result = await dispatcher.dispatch(
            {
              text: `directed partner result ${childCompletions}`,
              messageIds: [`message-${childCompletions}`],
              deliveryId: `delivery-${childCompletions}`,
            },
            { force: false, expectedInvocationId: 'live-invocation' },
          );
          results.push(result);
          if (!result.accepted) done.resolve();
        } catch (error) {
          errors.push(error);
          done.resolve();
        }
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(
      results.map((result) => result.accepted),
      [true, true],
    );
    assert.deepEqual(
      results.map((result) => result.handle.turnId),
      ['turn-2', 'turn-3'],
    );
    assert.equal(childCompletions, 3);
    assert.equal(releases, 1, 'only call termination releases the active invocation dispatcher');
    const inputs = f.writes.filter((row) => row.method === 'turn/start');
    assert.equal(inputs.length, 3);
    assert.deepEqual(
      inputs.slice(1).map((row) => row.params.clientUserMessageId),
      ['delivery-1', 'delivery-2'],
    );
    assert.ok(inputs.slice(1).every((row) => row.params.input[0].text.includes('directed partner result')));
  },
);

test(
  'Live Queue serializes concurrent handoffs onto the new turn and separates acceptance from consumption',
  { timeout: 3000 },
  async () => {
    const f = wireFixture({ holdFirstTurn: true });
    const done = Promise.withResolvers();
    const consumed = Promise.withResolvers();
    const write = f.wire.write;
    let starts = 0;
    let nativeItems = [];
    f.wire.write = async (row) => {
      if (row.method === 'turn/start' && ++starts > 1) {
        f.writes.push(row);
        f.push({ id: row.id, result: { turn: { id: 'next-root' } } });
      } else if (row.method === 'thread/read') {
        f.writes.push(row);
        f.push({
          id: row.id,
          result: {
            thread: {
              id: 'native',
              turns: [
                { id: 'first', items: [{ type: 'userMessage', clientId: 'unsubmitted' }] },
                { id: 'next-root', items: nativeItems },
              ],
            },
          },
        });
      } else await write(row);
    };
    let dispatcher;
    let readCount = 0;
    let outcome;
    const errors = [];
    const read = async () => {
      if (++readCount === 2) consumed.resolve();
    };
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'voice bootstrap' },
      activeRunDispatch: {
        invocationId: 'live-invocation',
        register: (value) => {
          dispatcher = value;
        },
      },
      live: {
        finished: done.promise,
        ready: async () => {
          f.push(f.completed('first'));
        },
        observe: async () => {},
      },
    })) {
      if (event.type === 'app_server.live_turn_completed' && event.turnId === 'next-root') {
        done.resolve();
        continue;
      }
      if (event.type !== 'app_server.live_turn_completed' || event.turnId !== 'first') continue;
      setImmediate(async () => {
        try {
          const wrong = await dispatcher.dispatch(
            { text: 'wrong invocation', messageIds: ['wrong'] },
            { force: false, expectedInvocationId: 'another-invocation' },
          );
          assert.equal(wrong.accepted, false);
          assert.equal(wrong.reason, 'active_run_mismatch');
          outcome = await Promise.all(
            ['delivery-a', 'delivery-b'].map((id) =>
              dispatcher.dispatch(
                {
                  text: id,
                  imagePaths: id === 'delivery-a' ? ['/synthetic/image.png'] : [''],
                  messageIds: [id],
                  deliveryId: id,
                  onInputRead: read,
                },
                { force: false, expectedInvocationId: 'live-invocation' },
              ),
            ),
          );
          assert.deepEqual(
            outcome.map((r) => r.handle.turnId),
            ['next-root', 'next-root'],
          );
          assert.equal(dispatcher.handle.turnId, 'next-root');
          assert.equal(readCount, 0, 'RPC acknowledgement is not model consumption');
          assert.equal(await dispatcher.inspectInput('delivery-a'), 'unknown');
          assert.equal(
            await dispatcher.inspectInput('unsubmitted'),
            'unknown',
            'another historical input is not this Queue handoff',
          );
          nativeItems = ['delivery-a', 'delivery-b'].map((clientId) => ({ type: 'userMessage', clientId }));
          assert.equal(await dispatcher.inspectInput('delivery-a'), 'accepted');
          assert.equal(readCount, 0, 'inspection acceptance is not an input-read callback');
          for (const threadId of ['foreign', 'native']) {
            f.push({
              method: 'item/completed',
              params: {
                threadId,
                turnId: threadId === 'foreign' ? 'next-root' : 'first',
                item: { type: 'userMessage', clientId: 'delivery-a' },
              },
            });
          }
          await new Promise(setImmediate);
          assert.equal(readCount, 0);
          for (const clientId of ['delivery-a', 'delivery-b', 'delivery-a'])
            f.push({
              method: 'item/completed',
              params: { threadId: 'native', turnId: 'next-root', item: { type: 'userMessage', clientId } },
            });
          await consumed.promise;
          f.push(f.completed('next-root'));
        } catch (error) {
          errors.push(error);
          done.resolve();
        }
      });
    }
    assert.deepEqual(errors, []);
    assert.equal(readCount, 2, 'each exact Queue input is observed once');
    assert.ok(outcome.every((result) => result.accepted));
    const inputs = f.writes.filter((row) => ['turn/start', 'turn/steer'].includes(row.method));
    assert.deepEqual(
      inputs.map((row) => row.method),
      ['turn/start', 'turn/start', 'turn/steer'],
    );
    assert.equal(inputs[2].params.expectedTurnId, 'next-root');
    assert.deepEqual(inputs[1].params.input[1], { type: 'localImage', path: '/synthetic/image.png' });
    assert.deepEqual(
      inputs[2].params.input,
      [{ type: 'text', text: 'delivery-b' }],
      'empty image paths remain filtered before the native boundary',
    );
    assert.equal(
      f.writes.some((row) => row.method === 'thread/realtime/appendText'),
      false,
      'Queue input is not duplicated as a typed-owner utterance',
    );
    const afterStop = await dispatcher.dispatch(
      { text: 'late', messageIds: ['late'] },
      { force: false, expectedInvocationId: 'live-invocation' },
    );
    assert.equal(afterStop.accepted, false);
    assert.equal(afterStop.acceptance, 'not_accepted');
  },
);

test('Live keeps exact late consumption after an ambiguous idle-turn RPC reply', { timeout: 3000 }, async () => {
  const f = wireFixture();
  const write = f.wire.write;
  let starts = 0;
  let readCount = 0;
  let observedReadTurn;
  const consumedTurns = [];
  let result;
  let dispatcher;
  const done = Promise.withResolvers();
  const read = Promise.withResolvers();
  const settled = Promise.withResolvers();
  const errors = [];
  f.wire.write = async (row) => {
    if (row.method !== 'turn/start' || ++starts === 1) {
      await write(row);
      return;
    }
    f.writes.push(row);
    f.push({ id: row.id, error: { code: -32603, message: 'ambiguous provider reply' } });
    f.push({
      method: 'item/completed',
      params: {
        threadId: 'native',
        turnId: null,
        item: { type: 'userMessage', clientId: row.params.clientUserMessageId },
      },
    });
    f.push({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'accepted-after-error' } } });
    f.push({
      method: 'item/completed',
      params: {
        threadId: 'foreign',
        turnId: 'accepted-after-error',
        item: { type: 'userMessage', clientId: row.params.clientUserMessageId },
      },
    });
    f.push({
      method: 'item/completed',
      params: {
        threadId: 'native',
        turnId: 'accepted-after-error',
        item: { type: 'userMessage', clientId: row.params.clientUserMessageId },
      },
    });
    f.push(f.completed('accepted-after-error'));
  };
  for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
    thread: { kind: 'start' },
    prompt: { kind: 'frozen', prompt: 'voice bootstrap' },
    activeRunDispatch: {
      invocationId: 'live-invocation',
      register: (value) => {
        dispatcher = value;
      },
    },
    live: {
      finished: done.promise,
      ready: async () => {},
      observe: async (row) => {
        if (row.method === 'item/completed' && row.params.threadId === 'native') observedReadTurn = row.params.turnId;
      },
    },
  })) {
    if (event.type !== 'app_server.live_turn_completed') continue;
    if (event.turnId !== 'first') {
      await Promise.all([read.promise, settled.promise]);
      done.resolve();
      continue;
    }
    setImmediate(async () => {
      try {
        result = await dispatcher.dispatch(
          {
            text: 'source-linked partner result',
            messageIds: ['message-a'],
            deliveryId: 'delivery-a',
            onInputRead: async () => {
              readCount++;
              consumedTurns.push(observedReadTurn);
              read.resolve();
            },
          },
          { force: false, expectedInvocationId: 'live-invocation' },
        );
      } catch (error) {
        errors.push(error);
        done.resolve();
      } finally {
        settled.resolve();
      }
    });
  }
  assert.deepEqual(errors, []);
  assert.equal(result.accepted, false);
  assert.equal(result.acceptance, 'unknown');
  assert.equal(readCount, 1, 'only actual native consumption, not the uncertain RPC, is a read receipt');
  assert.deepEqual(consumedTurns, ['accepted-after-error'], 'a missing native turn id is never consumption evidence');
});
