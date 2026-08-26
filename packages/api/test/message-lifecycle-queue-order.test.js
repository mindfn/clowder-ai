import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { compareLifecycleQueueEntries, compareQueueOrderShadow, rememberBoundedShadowScope, summarizeQueueOrderShadow } =
  await import('../dist/domains/cats/services/agents/invocation/message-lifecycle-queue-order.js');

describe('canonical lifecycle Queue order', () => {
  it('sorts only by position, priority, FIFO time, and id', () => {
    const entries = [
      { id: 'normal-old', priority: 'normal', enqueuedAt: 10 },
      { id: 'urgent-new', priority: 'urgent', enqueuedAt: 30 },
      { id: 'urgent-old-z', priority: 'urgent', enqueuedAt: 20 },
      { id: 'urgent-old-a', priority: 'urgent', enqueuedAt: 20 },
      { id: 'positioned', priority: 'normal', position: 4, enqueuedAt: 40 },
    ];

    assert.deepEqual(
      entries.sort(compareLifecycleQueueEntries).map((entry) => entry.id),
      ['positioned', 'urgent-old-a', 'urgent-old-z', 'urgent-new', 'normal-old'],
    );
  });
});

describe('legacy/new order shadow comparison', () => {
  it('reports the first order delta without changing either side', () => {
    const newEntries = [
      { id: 'normal', priority: 'normal', enqueuedAt: 10 },
      { id: 'urgent', priority: 'urgent', enqueuedAt: 20 },
    ];
    assert.deepEqual(compareQueueOrderShadow(['normal', 'urgent'], newEntries), {
      matches: false,
      legacyEntryIds: ['normal', 'urgent'],
      lifecycleEntryIds: ['urgent', 'normal'],
      firstMismatchIndex: 0,
    });
  });

  it('bounds remembered scopes and emits only bounded samples plus digests', () => {
    const scopes = new Set();
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-a', 2), true);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-a', 2), false);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-b', 2), true);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-c', 2), true);
    assert.deepEqual([...scopes], ['scope-b', 'scope-c']);

    const comparison = compareQueueOrderShadow(
      ['a', 'b', 'c', 'd'],
      [
        { id: 'd', priority: 'urgent', enqueuedAt: 4 },
        { id: 'c', priority: 'urgent', enqueuedAt: 3 },
        { id: 'b', priority: 'normal', enqueuedAt: 2 },
        { id: 'a', priority: 'normal', enqueuedAt: 1 },
      ],
    );
    const summary = summarizeQueueOrderShadow(comparison, 2);
    assert.equal(summary.legacyCount, 4);
    assert.equal(summary.lifecycleCount, 4);
    assert.equal(summary.legacyEntryIdSample.length, 2);
    assert.equal(summary.lifecycleEntryIdSample.length, 2);
    assert.match(summary.legacyOrderDigest, /^[a-f0-9]{16}$/);
    assert.match(summary.lifecycleOrderDigest, /^[a-f0-9]{16}$/);
  });
});
