/**
 * F257 #2 — native-L0 L-series (L1-L7) observability via the ACTUAL L0 compiler manifest.
 *
 * Reworked per sol 2b R1: the trace is sourced from the compiled artifact
 * (`getL0ManifestViaSubprocess`), not an out-of-band pipeline reconstruction. Covers:
 *  - adapter: manifest → session PipelineResult (fired L1-L7; empty → null);
 *  - bridge: ObservedSegments + delivery channel `native-l0` (P1-1);
 *  - §16e reachability: persisted L4 found by the segment-lifeline predicate;
 *  - producer seam (persistNativeL0SessionTrace): success persists L1-L7 with native-l0
 *    channel; empty manifest → visible warning + NO false L data (P2-1 failure path).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

// ── FakeRedis (ZSET + SADD/SMEMBERS) — mirrors segment-lifeline.test.js ──
class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
  }
  async set(key, value) {
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key) {
    return this.kv.get(key) ?? null;
  }
  async del(key) {
    this.kv.delete(key);
    return 1;
  }
  async zadd(key, score, member) {
    const s = this.sorted.get(key) ?? new Map();
    s.set(member, score);
    this.sorted.set(key, s);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .filter(([, sc]) => sc >= min && sc <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrevrange(key, start, stop) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1)
      .map(([m]) => m);
  }
  async zrem(key, member) {
    return this.sorted.get(key)?.delete(member) ? 1 : 0;
  }
  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    for (const m of members) s.add(m);
    this.sets.set(key, s);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async scan(_c, ...args) {
    const i = args.indexOf('MATCH');
    const pat = i >= 0 ? args[i + 1] : '*';
    const rx = new RegExp(`^${pat.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', [...new Set([...this.kv.keys(), ...this.sorted.keys()])].filter((k) => rx.test(k))];
  }
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'l0-lseries-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  return root;
}

/** Fake spawn that writes the compiler manifest to --manifest-out (like the real CLI). */
function buildManifestSpawn({ compiled = 'PROMPT', manifest = [] }) {
  const fn = function fakeSpawn(_cmd, args) {
    fn.calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const oi = args.indexOf('--out');
      if (oi >= 0 && args[oi + 1]) writeFileSync(args[oi + 1], compiled, 'utf8');
      const mi = args.indexOf('--manifest-out');
      if (mi >= 0 && args[mi + 1]) writeFileSync(args[mi + 1], JSON.stringify(manifest), 'utf8');
      if (oi < 0) child.stdout.emit('data', Buffer.from(compiled));
      child.emit('close', 0);
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

const RAW = [
  { id: 'L1', content: '你不是一个孤立的工具' },
  { id: 'L2', content: '客观性 carry-over' },
  { id: 'L3', content: '传球三选一' },
  { id: 'L4', content: '五条铁律：Runtime data safety…' },
  { id: 'L5', content: 'MCP 工具 index' },
  { id: 'L6', content: '能力唤醒' },
  { id: 'L7', content: '协作哲学' },
];
const L_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
const manifestContent = RAW.map((e) => ({ segmentId: e.id, content: e.content }));

describe('F257 #2: native-L0 L-series via compiler manifest', () => {
  let adapter;
  let bridge;
  let StoreMod;
  let l0c;
  let native;

  before(async () => {
    adapter = await import('../dist/domains/prompt-hooks/l0-manifest-trace.js');
    bridge = await import('../dist/domains/prompt-hooks/trace-bridge.js');
    StoreMod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    l0c = await import('../dist/domains/cats/services/agents/providers/l0-compiler.js');
    native = await import('../dist/domains/prompt-hooks/native-l0-trace.js');
  });

  after(() => l0c?.clearL0Cache());

  test('l0ManifestToSessionResult → L1-L7 fired events + content patches', () => {
    const r = adapter.l0ManifestToSessionResult(manifestContent);
    assert.ok(r, 'non-null for a populated manifest');
    assert.deepEqual(r.events.map((e) => e.hookId).sort(), L_IDS);
    assert.ok(
      r.events.every((e) => e.status === 'fired'),
      'all fired',
    );
    assert.ok(
      r.events.every((e) => e.contentHash && typeof e.version === 'number'),
      'hash+version set',
    );
    assert.ok(
      r.patches.every((p) => p.content.length > 0),
      'patches carry the compiled content',
    );
  });

  test('empty manifest → null (visible signal, not a silent empty session)', () => {
    assert.equal(adapter.l0ManifestToSessionResult([]), null);
  });

  test('bridge maps to observed L1-L7 with native-l0 delivery channel (P1-1)', () => {
    const sessionResult = adapter.l0ManifestToSessionResult(manifestContent);
    const b = bridge.buildFromPipeline(sessionResult, null, {
      turnId: 't1',
      threadId: 'thread-A',
      catId: 'opus',
      hasNativeL0: true,
      sessionFromNativeCompiler: true,
    });
    const lSegs = b.summary.segments.filter((s) => /^L\d/.test(s.segmentId));
    assert.equal(lSegs.length, 7);
    assert.ok(lSegs.every((s) => s.status === 'observed' && s.pipelineStatus === 'fired'));
    const session = b.summary.delivery.find((d) => d.stage === 'session-init');
    assert.equal(session.channel, 'native-l0', 'L1-L7 delivered via native L0, not pack-only');
  });

  test('§16e reachability: persisted L4 found by segment-lifeline predicate', async () => {
    const sessionResult = adapter.l0ManifestToSessionResult(manifestContent);
    const b = bridge.buildFromPipeline(sessionResult, null, {
      turnId: 't1',
      threadId: 'thread-A',
      catId: 'opus',
      hasNativeL0: true,
      sessionFromNativeCompiler: true,
    });
    const store = new StoreMod.InjectionTraceStore(new FakeRedis());
    await store.persist(b.summary, b.detail);
    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-A'));
    const summaries = await store.queryWindow('thread-A', 0, Date.now() + 1000);
    const found = summaries.flatMap((s) => s.segments).filter((s) => s.segmentId === 'L4' && s.status === 'observed');
    assert.equal(found.length, 1, 'L4 reachable by the exact lifeline predicate');
    assert.ok(found[0].charCount > 0);
  });

  test('seam: persistNativeL0SessionTrace persists L1-L7 (native-l0) from the compiler cache', async () => {
    l0c.clearL0Cache();
    const root = makeRoot();
    const spawnFn = buildManifestSpawn({ manifest: RAW });
    // Warm the manifest cache via the fake compiler; the helper's cache-first read hits it.
    await l0c.getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });

    const persisted = [];
    const warns = [];
    await native.persistNativeL0SessionTrace({
      traceStore: { persist: async (summary, detail) => persisted.push({ summary, detail }) },
      catId: 'opus-47',
      threadId: 'thread-A',
      turnId: 't1',
      turnResult: null,
      log: { warn: (_o, m) => warns.push(m) },
    });

    assert.equal(persisted.length, 1, 'trace persisted');
    const lSegs = persisted[0].summary.segments.filter((s) => /^L\d/.test(s.segmentId));
    assert.equal(lSegs.length, 7, 'all L1-L7 persisted');
    const session = persisted[0].summary.delivery.find((d) => d.stage === 'session-init');
    assert.equal(session.channel, 'native-l0');
    assert.equal(warns.length, 0, 'no producer warning when manifest present');
  });

  test('seam failure path: empty manifest → visible warning + NO false L data (P2-1)', async () => {
    l0c.clearL0Cache();
    const root = makeRoot();
    const spawnFn = buildManifestSpawn({ compiled: 'STILL-COMPILES', manifest: [] });
    await l0c.getL0ManifestViaSubprocess({ catId: 'codex', cwd: root, spawnFn });

    const persisted = [];
    const warns = [];
    await native.persistNativeL0SessionTrace({
      traceStore: { persist: async (summary) => persisted.push(summary) },
      catId: 'codex',
      threadId: 'thread-B',
      turnId: 't2',
      turnResult: null,
      log: { warn: (_o, m) => warns.push(m) },
    });

    assert.ok(
      warns.some((m) => /manifest empty/.test(m)),
      'empty manifest emits a visible producer warning (distinguishable from healthy zero)',
    );
    const lPersisted = persisted.flatMap((s) => s.segments ?? []).filter((s) => /^L\d/.test(s.segmentId));
    assert.equal(lPersisted.length, 0, 'no fabricated L segments when the compiler produced no manifest');
  });
});
