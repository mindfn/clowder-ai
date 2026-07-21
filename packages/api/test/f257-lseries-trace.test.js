/**
 * F257 #2 — native-L0 L-series (L1-L7) segment observability.
 *
 * Root cause (verified by reading route-parallel.ts:251-401 + trace-bridge.ts:50-52):
 * native-L0 cats build session identity via buildStaticIdentityPackOnly() which does
 * NOT run the hook pipeline, so drainCapturedTraces().session is null. buildFromPipeline
 * then returns non-null via the per-turn (D) result with an EMPTY session-segment array —
 * the collectTrace 'session-init-pack-only' fallback (trace-collector.ts:116-129) is never
 * reached. Result: L1-L7 never appear as ObservedSegments → segment-lifeline is blank for
 * every native-L0 cat (Claude/Codex/OpenCode).
 *
 * Fix: collectNativeL0SessionTrace() runs the session-init pipeline in trace-only mode
 * (prompt discarded) and returns the L-scoped PipelineResult, fed as buildFromPipeline's
 * sessionResult for native-L0. eventsToSegments already maps L1-L7 → ObservedSegments.
 *
 * This test proves L1-L7 become per-segment observed AND reachable by the segment-lifeline
 * read-model (§16e full-chain reachability, not just structural shape).
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

// ── FakeRedis (ZSET + SADD/SMEMBERS) — mirrors segment-lifeline.test.js ──
class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
    this.ttls = new Map();
  }
  async set(key, value, ...args) {
    this.kv.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') this.ttls.set(key, args[1]);
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
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, score);
    this.sorted.set(key, set);
    return 1;
  }
  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }
  async zrevrange(key, start, stop) {
    const set = this.sorted.get(key);
    if (!set) return [];
    const entries = [...set.entries()].sort((a, b) => b[1] - a[1]);
    return entries.slice(start, stop + 1).map(([m]) => m);
  }
  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }
  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    this.sets.set(key, s);
    return added;
  }
  async smembers(key) {
    const s = this.sets.get(key);
    return s ? [...s] : [];
  }
  async scan(_cursor, ...args) {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
    const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
    const allKeys = new Set([...this.kv.keys(), ...this.sorted.keys()]);
    return ['0', [...allKeys].filter((k) => regex.test(k))];
  }
}

const L_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

describe('F257 #2: native-L0 L-series observability', () => {
  let PipelineBuilder;
  let TraceBridge;
  let InjectionTraceStoreMod;
  let HookRegistryMod;
  let monorepoRoot;
  let catReg;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;
    catReg.reset();
    // native-L0 cat (clientId anthropic) — config drives assembleForSession lookup.
    catReg.register('opus', {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见，喜欢深入分析问题',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    });

    PipelineBuilder = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
    TraceBridge = await import('../dist/domains/prompt-hooks/trace-bridge.js');
    InjectionTraceStoreMod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    HookRegistryMod = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    monorepoRoot = await import('../dist/utils/monorepo-root.js');
    // Fresh scan — avoid stale override snapshot from prior tests sharing the singleton.
    PipelineBuilder.resetPipelineSingleton();
  });

  after(() => {
    catReg?.reset();
    PipelineBuilder?.resetPipelineSingleton();
  });

  test('collectNativeL0SessionTrace returns all L1-L7 fired, no S/D leakage', () => {
    const result = PipelineBuilder.collectNativeL0SessionTrace('opus', { mcpAvailable: true });
    assert.ok(result, 'should return a PipelineResult (not null)');

    const eventIds = result.events.map((e) => e.hookId).sort();
    assert.deepStrictEqual(eventIds, L_IDS, 'events scoped to L1-L7 only');
    assert.ok(
      result.events.every((e) => e.status === 'fired'),
      'all L hooks fire (disableable:false, always-on)',
    );

    const patchIds = result.patches.map((p) => p.hookId).sort();
    assert.deepStrictEqual(patchIds, L_IDS, 'patches scoped to L1-L7 only');
    assert.ok(
      result.patches.every((p) => p.content.length > 0),
      'each L patch carries rendered template content',
    );

    // No S/D leakage — the whole point of the L-scope filter.
    assert.ok(!result.events.some((e) => /^[SD]\d/.test(e.hookId)), 'no S/D events leak into L-series trace');
  });

  test('buildFromPipeline maps L-series to observed segments (bridge path, native-L0)', () => {
    const lResult = PipelineBuilder.collectNativeL0SessionTrace('opus', { mcpAvailable: true });
    // turnResult=null models the reachability crux: pre-fix the bridge returned non-null
    // with EMPTY session segments; post-fix the L-series session result carries L1-L7.
    const bridge = TraceBridge.buildFromPipeline(lResult, null, {
      turnId: 'turn-1',
      threadId: 'thread-A',
      catId: 'opus',
      hasNativeL0: true,
    });
    assert.ok(bridge, 'bridge non-null');

    const lSegs = bridge.summary.segments.filter((s) => /^L\d/.test(s.segmentId));
    assert.equal(lSegs.length, 7, 'summary carries all 7 L segments');
    for (const s of lSegs) {
      assert.equal(s.status, 'observed', `${s.segmentId} observed`);
      assert.equal(s.pipelineStatus, 'fired', `${s.segmentId} pipelineStatus fired`);
      assert.equal(s.stage, 'session-init', `${s.segmentId} session-init stage`);
      assert.ok(s.contentHash, `${s.segmentId} contentHash set`);
      assert.ok(s.charCount > 0, `${s.segmentId} charCount > 0`);
      assert.equal(typeof s.version, 'number', `${s.segmentId} version set`);
    }
    assert.equal(bridge.summary.totalSegmentsObserved, 7, 'totalSegmentsObserved counts L1-L7');
  });

  test('§16e reachability: persisted L4 is found by segment-lifeline collectObservations predicate', async () => {
    const lResult = PipelineBuilder.collectNativeL0SessionTrace('opus', { mcpAvailable: true });
    const bridge = TraceBridge.buildFromPipeline(lResult, null, {
      turnId: 'turn-1',
      threadId: 'thread-A',
      catId: 'opus',
      hasNativeL0: true,
    });

    const redis = new FakeRedis();
    const store = new InjectionTraceStoreMod.InjectionTraceStore(redis);
    await store.persist(bridge.summary, bridge.detail);

    // Replicate segment-lifeline.collectObservations reachability path EXACTLY
    // (segment-lifeline.ts:150-158): listTracedThreadIds → queryWindow → predicate.
    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-A'), 'thread discoverable via registry');

    const summaries = await store.queryWindow('thread-A', 0, Date.now() + 1000);
    const found = [];
    for (const summary of summaries) {
      const seg = summary.segments.find((s) => s.segmentId === 'L4' && s.status === 'observed');
      if (seg) found.push(seg);
    }
    assert.equal(found.length, 1, 'L4 reachable by the exact lifeline predicate (was blank pre-fix)');
    assert.equal(found[0].pipelineStatus, 'fired');
    assert.ok(found[0].charCount > 0, 'L4 charCount surfaced');
    assert.equal(found[0].version, 1, 'L4 version surfaced for lifeline chain');
  });

  test('L4 name/version resolvable via HookRegistry (lifeline chain metadata)', () => {
    const root = monorepoRoot.findMonorepoRoot();
    const registry = new HookRegistryMod.HookRegistry(
      join(root, 'assets', 'prompt-hooks'),
      join(root, 'assets', 'prompt-templates'),
    );
    registry.scan();
    const hook = registry.getHook('L4');
    assert.ok(hook, 'L4 hook resolves in registry');
    assert.equal(hook.manifest.id, 'L4');
    assert.ok(hook.manifest.name, 'L4 has a display name for the lifeline header');
  });
});
