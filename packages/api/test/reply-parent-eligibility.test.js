/**
 * #699: isEligibleReplyParent — unified parent eligibility predicate
 * Ensures cursor-gap fetched parents and callback replyTo validation
 * use the same complete predicate chain.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { isEligibleReplyParent } = await import(
  '../dist/domains/cats/services/stores/visibility.js'
);

/** Helper: minimal StoredMessage-like object */
function mockMsg(overrides) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'test',
    mentions: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

const catViewer = { type: 'cat', catId: 'opus' };
const defaultOpts = { threadId: 'thread-1', viewer: catViewer };

describe('#699: isEligibleReplyParent', () => {
  test('accepts a normal delivered message in same thread', () => {
    const parent = mockMsg({ deliveryStatus: 'delivered' });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts message with no deliveryStatus (legacy = delivered)', () => {
    const parent = mockMsg({});
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects queued parent', () => {
    const parent = mockMsg({ deliveryStatus: 'queued' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects canceled parent', () => {
    const parent = mockMsg({ deliveryStatus: 'canceled' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects deleted parent', () => {
    const parent = mockMsg({ deletedAt: Date.now() });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects system-user parent', () => {
    const parent = mockMsg({ userId: 'system', catId: null });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects briefing parent', () => {
    const parent = mockMsg({ origin: 'briefing' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects cross-thread parent', () => {
    const parent = mockMsg({ threadId: 'other-thread' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects unrevealed whisper invisible to viewer cat', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'], // opus is NOT a recipient
    });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts whisper visible to viewer cat', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['opus'], // opus IS a recipient
    });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts revealed whisper (visible to all)', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'],
      revealedAt: Date.now(),
    });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects other-cat stream message when hideOtherCatStreams=true', () => {
    const parent = mockMsg({ catId: 'codex', origin: 'stream' });
    assert.ok(!isEligibleReplyParent(parent, { ...defaultOpts, hideOtherCatStreams: true }));
  });

  test('accepts other-cat stream message when hideOtherCatStreams=false', () => {
    const parent = mockMsg({ catId: 'codex', origin: 'stream' });
    assert.ok(isEligibleReplyParent(parent, { ...defaultOpts, hideOtherCatStreams: false }));
  });

  test('user viewer sees all whispers', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'],
    });
    const userOpts = { threadId: 'thread-1', viewer: { type: 'user' } };
    assert.ok(isEligibleReplyParent(parent, userOpts));
  });
});
