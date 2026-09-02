#!/usr/bin/env node
// F-7 / F-4 dynamic falsifier on the ISOLATED stack only (writes cycle history fixtures).
// Usage: node iso-cycle-exercise.mjs --gate <worktree-with-dist> --redis-url redis://127.0.0.1:6378 [--owner default-user]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_PORTS = new Set(['6099', '6399', '3002']);
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const gate = args.get('--gate');
const redisUrl = args.get('--redis-url');
const owner = args.get('--owner') ?? 'default-user';
if (!gate || !redisUrl) throw new Error('usage: --gate <worktree> --redis-url <url> [--owner id]');
if (FORBIDDEN_PORTS.has(new URL(redisUrl).port)) throw new Error(`refusing runtime/sanctum redis ${redisUrl}`);

const req = createRequire(join(gate, 'package.json'));
const Redis = (await import(req.resolve('ioredis'))).default;
const dist = (rel) => pathToFileURL(join(gate, 'packages/api/dist', rel)).href;
const { ObjectiveEvaluationRuntime } = await import(
  dist('infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js')
);
const { loadEvaluationCatalog } = await import(dist('infrastructure/harness-eval/evaluation/evaluation-catalog.js'));
const { TraceAnnotationStore } = await import(
  dist('infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js')
);
const { InjectionTraceStore } = await import(dist('domains/prompt-hooks/InjectionTraceStore.js'));

const redis = new Redis(redisUrl, { keyPrefix: 'cat-cafe:', maxRetriesPerRequest: 3 });
const catalogResult = await loadEvaluationCatalog(gate);
if (!catalogResult.ok) throw new Error(catalogResult.error);
const version = { version: 'v-exercise', versionContentRef: 'exercise' };
const runtime = new ObjectiveEvaluationRuntime(redis, catalogResult.catalog, new TraceAnnotationStore(redis), {
  traceStore: new InjectionTraceStore(redis),
  resolveVersion: () => version,
});
const checker = runtime.cycleChecker;
const cycles = runtime.cycles;
const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail)}`);
};
const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
};
const currentKey = (objective) => `harness-cycle-current:${owner}:${objective}`;
const histKey = (objective, id) => `harness-cycle-history:${owner}:${objective}:${id}`;
const histIndex = (objective) => `harness-cycle-history-index:${owner}:${objective}`;
const DAY = 24 * 60 * 60 * 1000;

// A0: per-trace production path cost — checkTrace on the newest real invocation while cycles are idle.
const latest = await redis.zrevrange(`trace-owner-episode:${owner}`, 0, 0, 'WITHSCORES');
const latestInvocation = latest[0];
const latestAt = Number(latest[1]);
const a0 = await timed(() => checker.checkTrace(owner, latestInvocation, latestAt + 1));
record('A0 checkTrace(latest real invocation) ≤ 100 ms while all cycles idle (S1 gate P1)', a0.ms <= 100, {
  ms: a0.ms,
  requested: a0.value,
});

// A1: hourly path — checkKnownOwners over every objective.
const a1 = await timed(() => checker.checkKnownOwners(Date.now()));
const statuses = {};
for (const objective of catalogResult.catalog.registry.objectives) {
  const rec = JSON.parse(await redis.get(currentKey(objective.id)));
  statuses[objective.id] = `${rec.evalStatus}${rec.triggeredBy ? ':' + rec.triggeredBy.join('+') : ''}`;
}
const identity = JSON.parse(await redis.get(currentKey('identity-truth')));
record(
  'A1 checkKnownOwners ≤ 500 ms + identity-truth requested via cumulative',
  a1.ms <= 500 && identity.evalStatus === 'requested' && identity.triggeredBy.includes('cumulative'),
  {
    ms: a1.ms,
    requestedCount: a1.value,
    identity: { evalStatus: identity.evalStatus, triggeredBy: identity.triggeredBy, windows: identity.windows.length },
    statuses,
  },
);

// B: no re-open while requested.
const before = await redis.get(currentKey('identity-truth'));
const b = await timed(() => checker.checkObjective(owner, 'identity-truth', Date.now() + 1000));
record(
  'B no re-open while requested',
  b.value.status === 'active' && (await redis.get(currentKey('identity-truth'))) === before,
  { status: b.value.status, ms: b.ms },
);

// C: minimum interval after a closed cycle (fixture: previous cycle closed at T0 = 3 days ago).
const T0 = Date.now() - 3 * DAY;
const closed = {
  ...JSON.parse(before),
  cycleId: 'cycle-exercise-closed',
  cycleStart: T0 - 4 * DAY,
  cycleEnd: T0,
  evalStatus: 'written',
  windows: [{ start: T0 - 4 * DAY, end: T0 }],
  triggeredBy: ['cumulative'],
  evaluation: { metrics: [], overall: 'complete', writtenAt: T0, by: 'exercise' },
  governance: { decision: 'keep', reason: 'exercise', writtenAt: T0 },
  closedAt: T0,
};
await redis.del(currentKey('identity-truth'), histIndex('identity-truth'));
await redis.set(histKey('identity-truth', closed.cycleId), JSON.stringify(closed));
await redis.zadd(histIndex('identity-truth'), T0, closed.cycleId);
await cycles.initialize(owner, 'identity-truth', T0, version);
const cInterval = await checker.checkObjective(owner, 'identity-truth', T0 + 60 * 60 * 1000);
const cAfter = await checker.checkObjective(owner, 'identity-truth', Date.now());
record(
  'C interval blocks at closedAt+1h, triggers after 2h with start=prev cycleEnd',
  cInterval.status === 'interval' &&
    cAfter.status === 'requested' &&
    cAfter.record.cycleStart === T0 &&
    cAfter.record.windows.length === 1,
  {
    first: cInterval.status,
    second: cAfter.status,
    cycleStart: cAfter.record.cycleStart,
    windows: cAfter.record.windows.length,
    triggeredBy: cAfter.record.triggeredBy,
  },
);

// D: skip lookback — two consecutive skipped cycles before the current one, one kept cycle before them.
const mk = (id, start, end, extra) => ({
  ...closed,
  cycleId: id,
  cycleStart: start,
  cycleEnd: end,
  windows: [{ start, end }],
  closedAt: end,
  ...extra,
});
const kept = mk('cycle-exercise-kept', T0 - 4 * DAY, T0 - 3 * DAY, {});
const skipA = mk('cycle-exercise-skip-a', T0 - 3 * DAY, T0 - 2 * DAY, {
  evaluation: { metrics: [], overall: 'insufficient_evidence', writtenAt: T0 - 2 * DAY, by: 'exercise' },
  governance: undefined,
});
const skipB = mk('cycle-exercise-skip-b', T0 - 2 * DAY, T0, { approval: { state: 'skipped', rejectCount: 0, at: T0 } });
await redis.del(currentKey('identity-truth'), histIndex('identity-truth'));
for (const h of [kept, skipA, skipB]) {
  await redis.set(histKey('identity-truth', h.cycleId), JSON.stringify(h));
  await redis.zadd(histIndex('identity-truth'), h.closedAt, h.cycleId);
}
await cycles.initialize(owner, 'identity-truth', T0, version);
const d = await checker.checkObjective(owner, 'identity-truth', Date.now());
const w = d.record.windows;
const expectWindows = [
  [skipA.cycleStart, skipA.cycleEnd],
  [skipB.cycleStart, skipB.cycleEnd],
  [T0, d.record.cycleEnd],
];
const windowsOk =
  d.status === 'requested' && w.length === 3 && expectWindows.every(([s, e], i) => w[i].start === s && w[i].end === e);
record('D skip lookback: windows = [skipA, skipB, current], stops at kept cycle', windowsOk, {
  status: d.status,
  windows: w,
});

// E: F-2 sizes for every current record.
let maxBytes = 0;
for (const objective of catalogResult.catalog.registry.objectives) {
  const bytes = await redis.call('MEMORY', 'USAGE', `cat-cafe:${currentKey(objective.id)}`);
  maxBytes = Math.max(maxBytes, Number(bytes));
}
record('E max CycleRecord size < 1 KB (requested state)', maxBytes < 1024, { maxBytes });

await redis.quit();
console.log(
  JSON.stringify({ summary: { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length } }),
);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
