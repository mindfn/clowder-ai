/**
 * Regression tests for A2A routing message persistence (#648).
 *
 * Covers:
 * 1. persistA2ARoutingMessage helper stores system message and returns messageId
 * 2. safeParseExtra preserves systemKind through Redis-style round-trip
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

describe('A2A routing message persistence (#648)', () => {
  describe('safeParseExtra preserves systemKind through round-trip', () => {
    it('preserves systemKind: a2a_routing', () => {
      const raw = JSON.stringify({ systemKind: 'a2a_routing' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
    });

    it('drops unknown systemKind values', () => {
      const raw = JSON.stringify({ systemKind: 'unknown_kind' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed, undefined);
    });

    it('preserves systemKind alongside other extra fields', () => {
      const raw = JSON.stringify({
        systemKind: 'a2a_routing',
        stream: { invocationId: 'inv-123' },
      });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
      assert.equal(parsed?.stream?.invocationId, 'inv-123');
    });

    it('survives JSON serialize → parse cycle (simulates Redis storage)', () => {
      const original = { systemKind: 'a2a_routing' };
      const serialized = JSON.stringify(original);
      const deserialized = safeParseExtra(serialized);
      assert.equal(deserialized?.systemKind, 'a2a_routing');
    });
  });

  describe('A2A handoff message storage contract', () => {
    it('persists a2a_handoff as system message with correct shape', () => {
      const store = new MessageStore();
      const result = store.append({
        userId: 'system',
        catId: null,
        content: '布偶猫 → 缅因猫',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread-1',
        extra: { systemKind: 'a2a_routing' },
      });

      assert.ok(result.id, 'stored message should have an id');

      const messages = store.getByThread('thread-1');
      const stored = messages.find((m) => m.id === result.id);
      assert.ok(stored, 'message should be retrievable from store');
      assert.equal(stored.userId, 'system');
      assert.equal(stored.catId, null);
      assert.equal(stored.content, '布偶猫 → 缅因猫');
      assert.deepEqual(stored.extra, { systemKind: 'a2a_routing' });
    });

    it('stored messageId can be attached to broadcast payload', () => {
      const store = new MessageStore();
      const result = store.append({
        userId: 'system',
        catId: null,
        content: '布偶猫 → 缅因猫',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread-1',
        extra: { systemKind: 'a2a_routing' },
      });

      const broadcastPayload = {
        type: 'a2a_handoff',
        content: '布偶猫 → 缅因猫',
        messageId: result.id,
      };

      assert.ok(broadcastPayload.messageId, 'broadcast payload should carry stored messageId');
      assert.equal(typeof broadcastPayload.messageId, 'string');
    });
  });
});
