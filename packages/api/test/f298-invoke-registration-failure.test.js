import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

let dataDir;
let originalDataDir;
let originalPreflightDisable;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'f298-registration-failure-'));
  originalDataDir = process.env.DATA_DIR;
  originalPreflightDisable = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  process.env.DATA_DIR = dataDir;
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
});

after(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPreflightDisable === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalPreflightDisable;
  await rm(dataDir, { recursive: true, force: true });
});

test('F298 auth admission failure is typed before provider startup', async () => {
  const terminalCommits = [];
  let providerStarted = false;
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'child-registration-failed', callbackToken: 'token' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      async commitTerminal(input) {
        terminalCommits.push(input);
        return { outcome: 'committed', record: { state: input.disposition } };
      },
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    turnExecutionStore: {
      async createRunning() {
        throw new Error('durable registration unavailable');
      },
    },
  };
  const service = {
    async *invoke() {
      providerStarted = true;
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  const messages = [];
  for await (const message of invokeSingleCat(deps, {
    catId: 'codex',
    service,
    prompt: 'test',
    userId: 'user-1',
    threadId: 'thread-1',
    parentInvocationId: 'parent-1',
    isLastCat: true,
  })) {
    messages.push(message);
  }

  assert.equal(providerStarted, false);
  assert.deepEqual(terminalCommits, [
    {
      invocationId: 'child-registration-failed',
      disposition: 'failed',
      endedAt: terminalCommits[0].endedAt,
      endReason: 'registration_failed',
    },
  ]);
  assert.match(messages.find((message) => message.type === 'error')?.error ?? '', /durable registration unavailable/);
});
