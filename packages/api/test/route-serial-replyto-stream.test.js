import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

function createMockService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls, initialMessages = []) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();

  for (const msg of initialMessages) storedById.set(msg.id, msg);

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        };
        appendCalls.push(msg);
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

function withClaimedA2ASlot(options = {}) {
  return {
    invocationController: new AbortController(),
    trackA2ASlot: () => true,
    completeA2ASlots: () => {},
    ...options,
  };
}

describe('routeSerial replyTo on stream messages', () => {
  /** Save / restore catRegistry so mention detection resolves @缅因猫 → codex. */
  let savedConfigs;
  before(() => {
    savedConfigs = catRegistry.getAllConfigs();
    const minCat = (id, displayName, mentionPatterns, clientId, defaultModel) => ({
      id,
      name: id,
      displayName,
      avatar: '',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns,
      clientId,
      defaultModel,
      mcpSupport: true,
      roleDescription: 'test',
      personality: 'test',
    });
    if (!catRegistry.has('opus')) {
      catRegistry.register('opus', minCat('opus', '布偶猫', ['@布偶猫'], 'anthropic', 'claude-opus-4-6'));
    }
    if (!catRegistry.has('codex')) {
      catRegistry.register('codex', minCat('codex', '缅因猫', ['@缅因猫'], 'openai', 'gpt-5.3-codex'));
    }
  });
  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) {
      catRegistry.register(id, config);
    }
  });

  it('attaches replyTo + replyPreview to CLI A2A stream responses', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '我先看一下\n@缅因猫 帮忙复核'),
        codex: createMockService('codex', '收到，我来复核'),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'check this', 'user1', 'thread1', withClaimedA2ASlot())) {
      yielded.push(msg);
    }

    // LI-005: ack-liveness hint fires for codex (A2A invocation with no routing exit / durable trigger).
    // Filter business messages from guard notices to validate each category independently.
    const msgs = streamMsgs(appendCalls);
    const hints = guardNotices(appendCalls);
    assert.equal(msgs.length, 2, 'should persist both opus and codex stream messages');
    assert.equal(hints.length, 1, 'A2A ack-liveness hint should fire for codex (no routing exit)');
    assert.equal(msgs[0].replyTo, undefined, 'originating cat should not reply to anything');
    assert.equal(msgs[1].replyTo, 'msg-1', 'A2A stream reply should persist replyTo to trigger message');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, 'msg-1', 'stream text should carry replyTo for live ReplyPill rendering');
    assert.deepEqual(codexText.replyPreview, {
      senderCatId: 'opus',
      content: '我先看一下\n@缅因猫 帮忙复核',
    });
  });

  it('attaches replyTo and persists trigger provenance for queue-dispatched initial target', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createMockService('codex', '收到，我来复核'),
      },
      appendCalls,
      [
        {
          id: 'msg-trigger',
          userId: 'user1',
          catId: 'opus',
          content: '@缅因猫 帮忙复核',
          mentions: ['codex'],
          timestamp: 123,
          threadId: 'thread1',
        },
      ],
    );
    const registryCreateCalls = [];
    deps.invocationDeps.registry.create = (...args) => {
      registryCreateCalls.push(args);
      return { invocationId: 'inv-queue-trigger', callbackToken: 'tok-queue-trigger' };
    };

    const yielded = [];
    for await (const msg of routeSerial(deps, ['codex'], '@缅因猫 帮忙复核', 'user1', 'thread1', {
      a2aTriggerMessageId: 'msg-trigger',
    })) {
      yielded.push(msg);
    }

    // LI-005: ack-liveness hint fires for codex (queue-dispatched A2A, no routing exit / durable trigger).
    const msgs = streamMsgs(appendCalls);
    const hints = guardNotices(appendCalls);
    assert.equal(msgs.length, 1, 'should persist queue-dispatched codex stream message');
    assert.equal(hints.length, 1, 'A2A ack-liveness hint should fire (no routing exit)');
    assert.equal(msgs[0].replyTo, 'msg-trigger', 'queue-dispatched A2A stream should persist trigger replyTo');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, 'msg-trigger', 'live stream text should carry trigger replyTo');
    assert.deepEqual(codexText.replyPreview, {
      senderCatId: 'opus',
      content: '@缅因猫 帮忙复核',
    });
    assert.equal(
      registryCreateCalls[0]?.[4],
      'msg-trigger',
      'queue trigger provenance must reach the invocation auth record for terminal ACK resolution',
    );
  });

  it('does not treat currentUserMessageId as stream replyTo without explicit A2A trigger', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createMockService('codex', '普通排队消息回复'),
      },
      appendCalls,
      [
        {
          id: 'msg-user',
          userId: 'user1',
          catId: null,
          content: '普通用户消息',
          mentions: ['codex'],
          timestamp: 123,
          threadId: 'thread1',
        },
      ],
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['codex'], '普通用户消息', 'user1', 'thread1', {
      currentUserMessageId: 'msg-user',
    })) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'should persist normal queued stream message');
    assert.equal(appendCalls[0].replyTo, undefined, 'normal queue stream must not reply to currentUserMessageId');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, undefined, 'live stream must not carry a bogus user-message replyTo');
  });

  it('passes explicit trigger id into deferred queue dispatch when fairness gate defers text-scan A2A', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deferred = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '我先看一下\n@缅因猫 帮忙复核'),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(
      deps,
      ['opus'],
      'check this',
      'user1',
      'thread1',
      withClaimedA2ASlot({
        queueHasQueuedMessages: () => true,
        deferA2AEnqueue: (entry) => deferred.push(entry),
      }),
    )) {
      yielded.push(msg);
    }

    assert.ok(yielded.find((msg) => msg.type === 'text' && msg.catId === 'opus'));
    assert.equal(deferred.length, 1, 'should enqueue deferred A2A target instead of extending worklist');
    assert.equal(deferred[0].targetCats[0], 'codex');
    assert.equal(
      deferred[0].a2aTriggerMessageId,
      'msg-1',
      'deferred queue entry should keep the stored trigger message id',
    );
  });
});
