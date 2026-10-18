import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

for (const phase of ['recording', 'envelope']) {
  for (const failure of [false, true]) {
    test(
      `pump ${failure ? 'failure' : 'EOF'} during Queue ${phase} stays definitely unsubmitted`,
      { timeout: 3000 },
      async () => {
        const f = wireFixture();
        const read = f.wire.read;
        f.wire.read = () => ({
          async *[Symbol.asyncIterator]() {
            for await (const row of read()) yield row;
            if (failure) throw new Error('synthetic transport failure');
          },
        });
        const entered = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const idle = Promise.withResolvers();
        const finished = Promise.withResolvers();
        const prepared = (text) => ({
          v: 1,
          message: { body: text },
          nativeInstructions: [],
          runtime: {},
          tools: {},
          providerNativeVisibility: 'unknown',
        });
        let dispatcher;
        let readCount = 0;
        const client = new CodexAppServerClient({
          wire: f.wire,
          onEnvelope: async (direction, row) => {
            if (
              phase === 'envelope' &&
              direction === 'outbound' &&
              row.params?.clientUserMessageId === 'transport-input'
            ) {
              entered.resolve();
              await resume.promise;
            }
          },
        });
        const run = (async () => {
          for await (const event of client.run({
            thread: { kind: 'start' },
            prompt: { kind: 'frozen', prompt: 'bootstrap' },
            prepareRequest: prepared,
            prepareLiveRequest: (value) => prepared(value.text),
            beforeProviderLaunch: async (request) => {
              if (phase === 'recording' && request.message.body === 'queued') {
                entered.resolve();
                await resume.promise;
              }
              return { requestGenerationId: request.message.body, generationOrdinal: 1, sessionId: 'session' };
            },
            activeRunDispatch: {
              invocationId: 'live',
              register: (value) => {
                dispatcher = value;
              },
            },
            live: { finished: finished.promise, ready: async () => {}, observe: async () => {} },
          }))
            if (event.type === 'app_server.live_turn_completed') idle.resolve();
        })();
        const terminal = assert.rejects(run, /stream|synthetic transport failure/);
        try {
          await idle.promise;
          const result = dispatcher.dispatch(
            {
              text: 'queued',
              messageIds: ['source'],
              deliveryId: 'transport-input',
              onInputRead: async () => {
                readCount++;
              },
            },
            { force: false, expectedInvocationId: 'live' },
          );
          await entered.promise;
          await f.wire.close();
          // Wait for the actual read pump to process EOF/failure, not a guessed delay.
          await client.pumpPromise.catch(() => {});
          resume.resolve();
          assert.equal((await result).acceptance, 'not_accepted');
          await terminal;
          assert.equal(f.writes.filter((row) => row.method === 'turn/start').length, 1);
          assert.equal(
            f.writes.some((row) => row.method === 'turn/steer'),
            false,
          );
          assert.equal(readCount, 0);
        } finally {
          resume.resolve();
          finished.resolve();
          await f.wire.close();
          await terminal;
        }
      },
    );
  }
}
