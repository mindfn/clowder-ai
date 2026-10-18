import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

test(
  'idle Queue native turns record and settle their own exact request generations before writing',
  { timeout: 3000 },
  async () => {
    const f = wireFixture();
    const done = Promise.withResolvers();
    const records = [];
    const inputs = [];
    const outcomes = [];
    const receipts = [];
    let dispatcher;
    let count = 0;
    const prepared = (text, refs) => ({
      v: 1,
      message: { body: text, sourceRefs: refs.map((ref) => ({ owner: 'message', ref })) },
      nativeInstructions: [],
      runtime: {},
      tools: {},
      providerNativeVisibility: 'unknown',
    });
    const write = f.wire.write;
    f.wire.write = async (row) => {
      if (row.method === 'turn/start')
        assert.equal(
          records.at(-1).message.body,
          row.params.input[0].text,
          'a generation must precede each native root',
        );
      await write(row);
    };
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'bootstrap' },
      prepareRequest: (text) => prepared(text, ['bootstrap']),
      prepareLiveRequest: (input) => {
        inputs.push(input);
        return prepared(input.text, input.sourceRefs ?? [input.sourceRef]);
      },
      beforeProviderLaunch: async (request) => {
        records.push(request);
        return {
          requestGenerationId: `generation-${records.length}`,
          generationOrdinal: records.length,
          sessionId: 'session',
        };
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
      live: { finished: done.promise, ready: async () => {}, observe: async () => {} },
    })) {
      if (event.type !== 'app_server.live_turn_completed') continue;
      if (++count === 3) {
        done.resolve();
        continue;
      }
      const receipt = dispatcher.dispatch(
        {
          text: `exact queue body ${count}`,
          messageIds: [`source-${count}-a`, `source-${count}-b`],
          deliveryId: `delivery-${count}`,
        },
        { expectedInvocationId: 'live-invocation', force: false },
      );
      receipts.push(receipt);
      void receipt.then((value) => {
        if (!value.accepted) done.resolve();
      });
    }
    assert.ok((await Promise.all(receipts)).every((value) => value.accepted));
    assert.deepEqual(
      inputs.map((input) => input.sourceRefs),
      [
        ['source-1-a', 'source-1-b'],
        ['source-2-a', 'source-2-b'],
      ],
    );
    assert.deepEqual(
      outcomes.map((value) => [value.request.requestGenerationId, value.outcome, value.nativeTurnId]),
      [
        ['generation-2', 'accepted', 'turn-2'],
        ['generation-3', 'accepted', 'turn-3'],
      ],
    );
  },
);

test(
  'actual Codex service prepares Queue input with every message source and its own injection decision',
  { timeout: 5000 },
  async () => {
    const f = wireFixture();
    const done = Promise.withResolvers();
    const records = [];
    const outcomes = [];
    const results = [];
    const write = f.wire.write;
    f.wire.write = async (row) => {
      if (row.method === 'account/read' || row.method === 'configRequirements/read') {
        f.writes.push(row);
        f.push({
          id: row.id,
          result: row.method === 'account/read' ? { account: { type: 'chatgpt' } } : { requirements: null },
        });
      } else if (
        row.id &&
        ![
          'initialize',
          'config/read',
          'thread/start',
          'turn/start',
          'turn/steer',
          'thread/realtime/appendText',
        ].includes(row.method)
      ) {
        throw new Error(`Unhandled synthetic native request: ${row.method}`);
      } else await write(row);
    };
    let dispatcher;
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      model: 'gpt-test',
      l0CompilerFn: async () => 'synthetic L0',
      rawArchive: { append: async () => {} },
    });
    for await (const _event of service.invoke('bootstrap', {
      invocationId: 'live-invocation',
      callbackEnv: {},
      agentCarrierSessionFactory: async () => ({ ...f.wire, rememberSession() {} }),
      beforeProviderLaunch: async (request) => {
        records.push(request);
        return {
          requestGenerationId: `request-${records.length}`,
          generationOrdinal: records.length,
          sessionId: 'session',
        };
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
      liveCompanion: {
        configure: async () => ({}),
        finished: done.promise,
        ready: async () => {},
        observe: async (event) => {
          if (event.method !== 'turn/completed') return;
          if (event.params.turn.id !== 'first') {
            done.resolve();
            return;
          }
          setImmediate(async () => {
            const result = await dispatcher.dispatch(
              { text: 'exact partner reply', messageIds: ['partner-a', 'partner-b'], deliveryId: 'actual-queue' },
              { force: false, expectedInvocationId: 'live-invocation' },
            );
            results.push(result);
            if (!result.accepted) done.resolve();
          });
        },
      },
    })) {
      /* Fully drain the actual service and native adapter. */
    }
    assert.equal(results[0]?.accepted, true);
    assert.equal(records.length, 2);
    assert.deepEqual(records[1].message, {
      body: 'exact partner reply',
      injectionDecision: 'app_server_live_queue_input',
      sourceRefs: [
        { owner: 'message', ref: 'partner-a' },
        { owner: 'message', ref: 'partner-b' },
      ],
    });
    assert.equal(outcomes[0].request.requestGenerationId, 'request-2');
    assert.equal(outcomes[0].nativeTurnId, 'turn-2');
  },
);
