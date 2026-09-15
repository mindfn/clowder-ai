import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function failingService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'error',
        catId,
        content: 'configured model unavailable',
        error: 'configured model unavailable',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function depsFor(services, messageStore) {
  let invocation = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocation}`, callbackToken: `tok-${invocation}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore,
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
    socketManager: { broadcastToRoom() {} },
  };
}

describe('routeParallel failed A2A settlement', () => {
  test('each failed child closes its own response without a predecessor carrier', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const messageStore = new MessageStore();
    const services = {
      bengal: failingService('bengal'),
      lihua: failingService('lihua'),
    };

    for await (const _event of routeParallel(
      depsFor(services, messageStore),
      ['bengal', 'lihua'],
      'ideate from Fable',
      'owner-1',
      'thread-a2a-parallel-failure',
      {
        ownerAuthProvenance: 'strict',
        a2aTriggerMessageId: 'source-from-fable',
        a2aCallerCatId: 'fable',
        parentInvocationId: 'parent-invocation',
        onLifecycleInvocationStarted: async ({ catId, invocationId, startedAt }) => {
          const response = await messageStore.append({
            from: { kind: 'agent', catId },
            threadId: 'thread-a2a-parallel-failure',
            userId: 'owner-1',
            content: '',
            mentions: [],
            origin: 'stream',
            timestamp: startedAt,
            lifecycle: {
              kind: 'response',
              orderKey: `${startedAt}:${invocationId}`,
              invocationId,
              targetId: catId,
              inputEntryIds: ['entry-source'],
              inputMessageIds: ['source-from-fable'],
              status: 'processing',
              startedAt,
            },
          });
          return { responseMessageId: response.id, priorFrontierMessageId: null };
        },
      },
    )) {
      // exhaust both failed children
    }

    const messages = messageStore.getByThread('thread-a2a-parallel-failure', 100, 'owner-1');
    const responses = messages.filter((message) => message.lifecycle?.kind === 'response');
    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.equal(response.lifecycle.status, 'failed');
      assert.equal(response.content, 'configured model unavailable');
    }
    assert.equal(
      messages.some((message) => message.lifecycle?.kind === 'input'),
      false,
      'ordinary child failure must not create a second predecessor Queue carrier',
    );
  });
});
