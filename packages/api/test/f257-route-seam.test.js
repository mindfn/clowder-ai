/**
 * F257 #2 (2b R2 P2-2) — route seam: native-L0 identity is persisted via the compiler
 * manifest through BOTH route-serial and route-parallel, and non-native routing stays on
 * its existing session-trace path.
 *
 * The unit seam test starts at persistNativeL0SessionTrace and can't catch a route dropping
 * or mis-branching the call. This drives the real routes with a bootstrapped fake trace
 * store + a prewarmed manifest cache (sol's recipe — no broad full-suite driver): a
 * native-L0 service must yield persisted L1-L7 with channel `native-l0`; a non-native
 * service must NOT (no compiler L segments, not native-l0).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
  }
  async set(k, v) {
    this.kv.set(k, v);
    return 'OK';
  }
  async get(k) {
    return this.kv.get(k) ?? null;
  }
  async del(k) {
    this.kv.delete(k);
    return 1;
  }
  async zadd(k, score, m) {
    const s = this.sorted.get(k) ?? new Map();
    s.set(m, score);
    this.sorted.set(k, s);
    return 1;
  }
  async zrangebyscore(k, min, max) {
    const s = this.sorted.get(k);
    if (!s) return [];
    return [...s.entries()]
      .filter(([, sc]) => sc >= min && sc <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrevrange(k, a, b) {
    const s = this.sorted.get(k);
    if (!s) return [];
    return [...s.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(a, b + 1)
      .map(([m]) => m);
  }
  async zrem(k, m) {
    return this.sorted.get(k)?.delete(m) ? 1 : 0;
  }
  async sadd(k, ...ms) {
    const s = this.sets.get(k) ?? new Set();
    for (const m of ms) s.add(m);
    this.sets.set(k, s);
    return ms.length;
  }
  async smembers(k) {
    return [...(this.sets.get(k) ?? [])];
  }
  async scan(_c, ...args) {
    const i = args.indexOf('MATCH');
    const pat = i >= 0 ? args[i + 1] : '*';
    const rx = new RegExp(`^${pat.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', [...new Set([...this.kv.keys(), ...this.sorted.keys()])].filter((x) => rx.test(x))];
  }
}

const RAW = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'].map((id) => ({ id, content: `${id} governance content` }));

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'l0-seam-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  return root;
}

function buildManifestSpawn(manifest) {
  return function fakeSpawn(_cmd, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const mi = args.indexOf('--manifest-out');
      if (mi >= 0 && args[mi + 1]) writeFileSync(args[mi + 1], JSON.stringify(manifest), 'utf8');
      child.stdout.emit('data', Buffer.from('PROMPT'));
      child.emit('close', 0);
    });
    return child;
  };
}

function mockService(catId, { native }) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'reply', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
    ...(native ? { injectsL0Natively: () => true } : {}),
  };
}

function createMockDeps(services) {
  let inv = 0;
  let msg = 0;
  const byId = new Map();
  return {
    services,
    injectionTraceStore: true, // truthy → route runs the trailing drainCapturedTraces()
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++inv}`, callbackToken: `tok-${inv}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp/t' },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
        isRebornSession: async () => false,
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (m) => {
        const s = { id: `m-${++msg}`, ...m, threadId: m.threadId ?? 'default' };
        byId.set(s.id, s);
        return s;
      },
      getById: async (id) => byId.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

async function pollTrace(store, threadId, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summaries = await store.queryWindow(threadId, 0, Date.now() + 1000);
    const hit = summaries.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe('F257 #2 route seam (2b R2 P2-2)', () => {
  let routeParallel;
  let routeSerial;
  let l0c;
  let StoreMod;
  let catReg;
  let store;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;
    catReg.reset();
    for (const id of ['nativecat', 'plaincat']) {
      catReg.register(id, {
        displayName: '布偶猫',
        nickname: id,
        name: 'Ragdoll',
        roleDescription: 'x',
        personality: 'y',
        defaultModel: 'claude-opus-4-6',
        mentionPatterns: [`@${id}`],
        restrictions: [],
        clientId: 'anthropic',
        breedId: 'ragdoll',
      });
    }
    routeParallel = (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
    routeSerial = (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial;
    l0c = await import('../dist/domains/cats/services/agents/providers/l0-compiler.js');
    StoreMod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const traceBootstrap = await import('../dist/domains/prompt-hooks/trace-bootstrap.js');

    const redis = new FakeRedis();
    traceBootstrap.bootstrapTraceStore(redis);
    store = new StoreMod.InjectionTraceStore(redis);

    // Prewarm the manifest cache so the route's cache-first read hits it (no real subprocess).
    l0c.clearL0Cache();
    await l0c.getL0ManifestViaSubprocess({ catId: 'nativecat', cwd: makeRoot(), spawnFn: buildManifestSpawn(RAW) });
  });

  after(() => {
    catReg?.reset();
    l0c?.clearL0Cache();
  });

  async function drain(route, catId, threadId) {
    for await (const _m of route(
      createMockDeps({ [catId]: mockService(catId, { native: catId === 'nativecat' }) }),
      [catId],
      'hi',
      'user1',
      threadId,
      {},
    )) {
      // drain the route generator
    }
  }

  for (const [mode, getRoute] of [
    ['parallel', () => routeParallel],
    ['serial', () => routeSerial],
  ]) {
    test(`${mode}: native-L0 cat persists L1-L7 via the compiler manifest (native-l0 channel)`, async () => {
      const threadId = `seam-${mode}-native`;
      await drain(getRoute(), 'nativecat', threadId);
      const summary = await pollTrace(store, threadId, (s) => s.segments.some((x) => x.segmentId === 'L4'));
      assert.ok(summary, `${mode}: native-L0 trace was persisted`);
      const lSegs = summary.segments.filter((s) => /^L\d/.test(s.segmentId));
      assert.equal(lSegs.length, 7, 'all L1-L7 present');
      assert.ok(lSegs.every((s) => s.status === 'observed' && s.pipelineStatus === 'fired'));
      const session = summary.delivery.find((d) => d.stage === 'session-init');
      assert.equal(session.channel, 'native-l0', 'session delivered via native L0');
    });

    test(`${mode}: non-native cat stays on the existing path (no compiler L segments, not native-l0)`, async () => {
      const threadId = `seam-${mode}-plain`;
      await drain(getRoute(), 'plaincat', threadId);
      // let any fire-and-forget persist settle
      await new Promise((r) => setTimeout(r, 150));
      const summaries = await store.queryWindow(threadId, 0, Date.now() + 1000);
      const usedNativeL0 = summaries.some(
        (s) => s.delivery.find((d) => d.stage === 'session-init')?.channel === 'native-l0',
      );
      assert.equal(usedNativeL0, false, 'non-native must NOT use the native-l0 channel');
      const hasCompilerL = summaries.some((s) => s.segments.some((x) => /^L\d/.test(x.segmentId)));
      assert.equal(hasCompilerL, false, 'non-native session trace carries no compiler L segments');
    });
  }
});
