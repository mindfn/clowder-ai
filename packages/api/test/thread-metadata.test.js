/**
 * #872: Thread Metadata MCP Tests
 *
 * Tests for ThreadMetadataV1 type, merge semantics, in-memory store,
 * and parseThreadMetadataJson fail-open behavior.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadMetadataV1 merge semantics', () => {
  test('mergeThreadMetadata — empty patch on undefined returns v:1 skeleton', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const result = mergeThreadMetadata(undefined, {});
    assert.deepEqual(result, { v: 1 });
  });

  test('mergeThreadMetadata — append worktrees with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a'] };
    const result = mergeThreadMetadata(existing, {
      worktrees: ['/path/a', '/path/b'],
    });
    assert.deepEqual(result.worktrees, ['/path/a', '/path/b']);
  });

  test('mergeThreadMetadata — removeWorktrees removes items', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a', '/path/b'] };
    const result = mergeThreadMetadata(existing, {
      removeWorktrees: ['/path/a'],
    });
    assert.deepEqual(result.worktrees, ['/path/b']);
  });

  test('mergeThreadMetadata — worktrees set to undefined when all removed', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a'] };
    const result = mergeThreadMetadata(existing, {
      removeWorktrees: ['/path/a'],
    });
    assert.equal(result.worktrees, undefined);
  });

  test('mergeThreadMetadata — append PRs with dedupe by repo#number (case insensitive)', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      prs: [{ repo: 'owner/repo', number: 1 }],
    };
    const result = mergeThreadMetadata(existing, {
      prs: [
        { repo: 'Owner/Repo', number: 1 }, // duplicate (case-insensitive)
        { repo: 'owner/repo', number: 2 }, // new
      ],
    });
    assert.equal(result.prs?.length, 2);
    assert.deepEqual(result.prs?.[0], { repo: 'owner/repo', number: 1 });
    assert.deepEqual(result.prs?.[1], { repo: 'owner/repo', number: 2 });
  });

  test('mergeThreadMetadata — removePrs removes by key', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      prs: [
        { repo: 'owner/repo', number: 1 },
        { repo: 'owner/repo', number: 2 },
      ],
    };
    const result = mergeThreadMetadata(existing, {
      removePrs: [{ repo: 'Owner/Repo', number: 1 }],
    });
    assert.equal(result.prs?.length, 1);
    assert.deepEqual(result.prs?.[0], { repo: 'owner/repo', number: 2 });
  });

  test('mergeThreadMetadata — append issues with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const result = mergeThreadMetadata(undefined, {
      issues: [
        { repo: 'zts212653/clowder-ai', number: 872 },
        { repo: 'zts212653/clowder-ai', number: 872 }, // dup
      ],
    });
    assert.equal(result.issues?.length, 1);
    assert.deepEqual(result.issues?.[0], {
      repo: 'zts212653/clowder-ai',
      number: 872,
    });
  });

  test('mergeThreadMetadata — append features with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, features: ['F001'] };
    const result = mergeThreadMetadata(existing, {
      features: ['F001', 'F002'],
    });
    assert.deepEqual(result.features, ['F001', 'F002']);
  });

  test('mergeThreadMetadata — removeFeatures removes items', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, features: ['F001', 'F002'] };
    const result = mergeThreadMetadata(existing, {
      removeFeatures: ['F001'],
    });
    assert.deepEqual(result.features, ['F002']);
  });

  test('mergeThreadMetadata — notes merge: string sets, null deletes', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      notes: { key1: 'value1', key2: 'value2' },
    };
    const result = mergeThreadMetadata(existing, {
      notes: { key1: null, key3: 'value3' },
    });
    assert.deepEqual(result.notes, { key2: 'value2', key3: 'value3' });
  });

  test('mergeThreadMetadata — notes set to undefined when all deleted', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, notes: { key1: 'value1' } };
    const result = mergeThreadMetadata(existing, {
      notes: { key1: null },
    });
    assert.equal(result.notes, undefined);
  });

  test('mergeThreadMetadata — does not mutate existing object', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      worktrees: ['/path/a'],
      notes: { k: 'v' },
    };
    const snapshot = JSON.stringify(existing);
    mergeThreadMetadata(existing, {
      worktrees: ['/path/b'],
      notes: { k: null },
    });
    assert.equal(JSON.stringify(existing), snapshot);
  });

  test('mergeThreadMetadata — combined add and remove in single call', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      worktrees: ['/old'],
      prs: [{ repo: 'a/b', number: 1 }],
      features: ['F001'],
    };
    const result = mergeThreadMetadata(existing, {
      worktrees: ['/new'],
      removeWorktrees: ['/old'],
      prs: [{ repo: 'c/d', number: 2 }],
      removePrs: [{ repo: 'a/b', number: 1 }],
      features: ['F002'],
      removeFeatures: ['F001'],
    });
    assert.deepEqual(result.worktrees, ['/new']);
    assert.deepEqual(result.prs, [{ repo: 'c/d', number: 2 }]);
    assert.deepEqual(result.features, ['F002']);
  });
});

describe('parseThreadMetadataJson', () => {
  test('valid v1 JSON parses correctly', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const raw = JSON.stringify({
      v: 1,
      worktrees: ['/path'],
      prs: [{ repo: 'a/b', number: 1 }],
    });
    const result = parseThreadMetadataJson(raw);
    assert.ok(result);
    assert.equal(result.v, 1);
    assert.deepEqual(result.worktrees, ['/path']);
  });

  test('malformed JSON returns null (fail-open)', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson('not-json'), null);
  });

  test('wrong version returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 2 })), null);
  });

  test('non-object returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson('"string"'), null);
    assert.equal(parseThreadMetadataJson('42'), null);
    assert.equal(parseThreadMetadataJson('null'), null);
  });
});

describe('ThreadStore (in-memory) — threadMetadata', () => {
  test('getThreadMetadata returns null for thread without metadata', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    assert.equal(store.getThreadMetadata(thread.id), null);
  });

  test('updateThreadMetadata sets and getThreadMetadata reads', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    const meta = {
      v: 1,
      worktrees: ['/path/a'],
      prs: [{ repo: 'owner/repo', number: 1 }],
      features: ['F001'],
      notes: { branch: 'feat/872' },
    };
    store.updateThreadMetadata(thread.id, meta);
    const result = store.getThreadMetadata(thread.id);
    assert.deepEqual(result, meta);
  });

  test('updateThreadMetadata(null) clears metadata', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    store.updateThreadMetadata(thread.id, { v: 1, worktrees: ['/x'] });
    assert.ok(store.getThreadMetadata(thread.id));
    store.updateThreadMetadata(thread.id, null);
    assert.equal(store.getThreadMetadata(thread.id), null);
  });

  test('updateThreadMetadata on nonexistent thread is no-op', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    // Should not throw
    store.updateThreadMetadata('nonexistent', { v: 1 });
    assert.equal(store.getThreadMetadata('nonexistent'), null);
  });

  test('threadMetadata persists through get()', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    store.updateThreadMetadata(thread.id, {
      v: 1,
      issues: [{ repo: 'zts212653/clowder-ai', number: 872 }],
    });
    const loaded = store.get(thread.id);
    assert.ok(loaded?.threadMetadata);
    assert.deepEqual(loaded.threadMetadata.issues, [{ repo: 'zts212653/clowder-ai', number: 872 }]);
  });
});

describe('refKey', () => {
  test('generates lowercase dedupe key', async () => {
    const { refKey } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(refKey({ repo: 'Owner/Repo', number: 42 }), 'owner/repo#42');
  });
});
