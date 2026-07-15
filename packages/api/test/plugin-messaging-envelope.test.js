/**
 * K-1 / F258 — envelope pure projection (plan Task 4, D-1)
 * MessageEnvelope is a projection of StoredMessage — no second truth source.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/envelope.js')} */
let envelope;

before(async () => {
  envelope = await import('../dist/domains/messaging/envelope.js');
});

function pluginStoredMessage(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'hello world',
    mentions: [],
    timestamp: 1_800_000_000_000,
    extra: {
      pluginMessage: {
        instanceId: 'inst-a',
        revision: 3,
        provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
        elements: [
          { elementId: 'el-1', kind: 'text', payload: { text: 'hello world' } },
          { elementId: 'el-2', kind: 'text', payload: { text: 'appended' }, derivedFromElementId: 'el-1' },
        ],
        appendOps: [{ operationId: 'op-1', elementIds: ['el-2'] }],
      },
    },
    ...overrides,
  };
}

describe('projectEnvelope — plugin messages (D-1)', () => {
  test('projects canonical envelope from stored plugin message', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage());
    assert.ok(env);
    assert.equal(env.messageId, 'msg-1');
    assert.equal(env.threadId, 'thread-1');
    assert.equal(env.revision, 3);
    assert.deepEqual(env.actor, { kind: 'plugin', id: 'inst-a' });
    assert.deepEqual(env.audience, { kind: 'public' });
    assert.equal(env.payload.elements.length, 2);
    assert.equal(env.payload.provenance.epistemicStatus, 'inference');
    assert.equal(env.occurredAt, new Date(1_800_000_000_000).toISOString());
  });

  test('whisper visibility projects whisper audience with targets', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage({ visibility: 'whisper', whisperTo: ['cat-a', 'cat-b'] }));
    assert.deepEqual(env.audience, { kind: 'whisper', targets: ['cat-a', 'cat-b'] });
  });

  test('replyTo passes through', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage({ replyTo: 'msg-0' }));
    assert.equal(env.replyTo, 'msg-0');
  });
});

describe('projectEnvelope — host-relayed messages (snapshot support)', () => {
  test('user message → actor user, epistemic user_intent, deterministic text element', () => {
    const env = envelope.projectEnvelope({
      id: 'msg-u',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'user says hi',
      mentions: [],
      timestamp: 1_800_000_000_001,
    });
    assert.deepEqual(env.actor, { kind: 'user', id: 'user-1' });
    assert.equal(env.revision, 1);
    assert.equal(env.payload.provenance.epistemicStatus, 'user_intent');
    assert.deepEqual(env.payload.provenance.origin, { kind: 'host' });
    assert.deepEqual(env.payload.elements, [
      { elementId: 'el_msg-u_0', kind: 'text', payload: { text: 'user says hi' } },
    ]);
  });

  test('cat message → actor cat, epistemic inference', () => {
    const env = envelope.projectEnvelope({
      id: 'msg-c',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: 'cat replies',
      mentions: [],
      timestamp: 1_800_000_000_002,
    });
    assert.deepEqual(env.actor, { kind: 'cat', id: 'opus' });
    assert.equal(env.payload.provenance.epistemicStatus, 'inference');
  });

  test('deleted / tombstoned messages project to null', () => {
    assert.equal(envelope.projectEnvelope(pluginStoredMessage({ deletedAt: 1 })), null);
    assert.equal(envelope.projectEnvelope(pluginStoredMessage({ _tombstone: true, deletedAt: 1 })), null);
  });

  test('malformed pluginMessage extra degrades to null (fail-closed projection)', () => {
    const env = envelope.projectEnvelope(
      pluginStoredMessage({ extra: { pluginMessage: { instanceId: 42, revision: 'x', elements: 'nope' } } }),
    );
    assert.equal(env, null);
  });

  test('structurally malformed provenance, elements, and append records fail closed', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const malformed = [
      { ...base, provenance: {} },
      { ...base, elements: [{ elementId: 42, kind: 'text', payload: { text: 'x' } }] },
      { ...base, appendOps: [{ operationId: 'op-1', elementIds: [42] }] },
    ];
    for (const pluginMessage of malformed) {
      assert.equal(envelope.projectEnvelope(pluginStoredMessage({ extra: { pluginMessage } })), null);
    }
  });
});
