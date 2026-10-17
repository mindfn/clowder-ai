// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';

describe('MemoryPrTrackingStore', () => {
  /** @type {InstanceType<typeof MemoryPrTrackingStore>} */
  let store;

  beforeEach(() => {
    store = new MemoryPrTrackingStore();
  });

  it('registers and retrieves a PR entry', () => {
    const input = {
      repoFullName: 'zts212653/clowder-ai',
      prNumber: 42,
      catId: 'opus',
      threadId: 'thread-1',
      userId: 'user-1',
    };

    const entry = store.register(input);

    assert.strictEqual(entry.repoFullName, 'zts212653/clowder-ai');
    assert.strictEqual(entry.prNumber, 42);
    assert.strictEqual(entry.catId, 'opus');
    assert.strictEqual(entry.threadId, 'thread-1');
    assert.strictEqual(typeof entry.registeredAt, 'number');

    const found = store.get('zts212653/clowder-ai', 42);
    assert.deepStrictEqual(found, entry);
  });

  it('returns null for non-existent PR', () => {
    const result = store.get('owner/repo', 999);
    assert.strictEqual(result, null);
  });

  it('overwrites existing entry for same repo+pr', () => {
    store.register({
      repoFullName: 'owner/repo',
      prNumber: 10,
      catId: 'opus',
      threadId: 'thread-old',
      userId: 'user-1',
    });

    store.register({
      repoFullName: 'owner/repo',
      prNumber: 10,
      catId: 'codex',
      threadId: 'thread-new',
      userId: 'user-2',
    });

    const found = store.get('owner/repo', 10);
    assert.ok(found);
    assert.strictEqual(found.catId, 'codex');
    assert.strictEqual(found.threadId, 'thread-new');
  });

  it('removes a tracked PR', () => {
    store.register({
      repoFullName: 'owner/repo',
      prNumber: 5,
      catId: 'opus',
      threadId: 'thread-1',
      userId: 'user-1',
    });

    const removed = store.remove('owner/repo', 5);
    assert.strictEqual(removed, true);
    assert.strictEqual(store.get('owner/repo', 5), null);
  });

  it('returns false when removing non-existent PR', () => {
    const removed = store.remove('owner/repo', 999);
    assert.strictEqual(removed, false);
  });

  it('lists all entries sorted by registeredAt descending', async () => {
    store.register({
      repoFullName: 'owner/repo',
      prNumber: 1,
      catId: 'opus',
      threadId: 't-1',
      userId: 'u-1',
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    store.register({
      repoFullName: 'owner/repo',
      prNumber: 2,
      catId: 'codex',
      threadId: 't-2',
      userId: 'u-1',
    });

    const all = store.listAll();
    assert.strictEqual(all.length, 2);
    // Most recent first
    assert.strictEqual(all[0].prNumber, 2);
    assert.strictEqual(all[1].prNumber, 1);
  });

  it('isolates entries by repo (same PR number, different repo)', () => {
    store.register({
      repoFullName: 'owner/repo-a',
      prNumber: 1,
      catId: 'opus',
      threadId: 't-a',
      userId: 'u-1',
    });

    store.register({
      repoFullName: 'owner/repo-b',
      prNumber: 1,
      catId: 'codex',
      threadId: 't-b',
      userId: 'u-1',
    });

    const a = store.get('owner/repo-a', 1);
    const b = store.get('owner/repo-b', 1);
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.catId, 'opus');
    assert.strictEqual(b.catId, 'codex');
  });
});
