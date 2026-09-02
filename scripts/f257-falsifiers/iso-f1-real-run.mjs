#!/usr/bin/env node
// F-1 on the ISOLATED stack with exactly one real eval cat run: shrink every other Objective's window to "now"
// (no fan-out), give the target Objective a bounded window, trigger it, and wait for the structured writeback.
// Usage: node iso-f1-real-run.mjs --gate <worktree-with-dist> --redis-url redis://127.0.0.1:6378 --api-url http://127.0.0.1:3122 [--objective identity-truth] [--window-days 2] [--timeout-min 25]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_PORTS = new Set(['6099', '6399', '3002']);
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const gate = args.get('--gate');
const redisUrl = args.get('--redis-url');
const apiUrl = args.get('--api-url');
const owner = args.get('--owner') ?? 'default-user';
const objective = args.get('--objective') ?? 'identity-truth';
const windowDays = Number(args.get('--window-days') ?? 2);
const timeoutMin = Number(args.get('--timeout-min') ?? 25);
if (!gate || !redisUrl || !apiUrl) throw new Error('usage: --gate <dir> --redis-url <url> --api-url <url>');
if (FORBIDDEN_PORTS.has(new URL(redisUrl).port) || FORBIDDEN_PORTS.has(new URL(apiUrl).port))
  throw new Error('refusing runtime/sanctum ports');

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
const runtime = new ObjectiveEvaluationRuntime(redis, catalogResult.catalog, new TraceAnnotationStore(redis), {
  traceStore: new InjectionTraceStore(redis),
  resolveVersion: () => ({ version: 'v-f1', versionContentRef: 'f1' }),
});
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const key = (o) => `harness-cycle-current:${owner}:${o}`;

// 1) No fan-out: every other Objective starts its window now (idle records only; iso-only write).
let shrunk = 0;
for (const o of catalogResult.catalog.registry.objectives) {
  if (o.id === objective) continue;
  const raw = await redis.get(key(o.id));
  if (!raw) continue;
  const rec = JSON.parse(raw);
  if (rec.evalStatus !== 'idle') continue;
  await redis.set(key(o.id), JSON.stringify({ ...rec, cycleStart: now, windows: [] }));
  shrunk++;
}
// 2) Target Objective: fresh idle cycle with a bounded window.
await redis.del(key(objective));
await runtime.cycles.initialize(owner, objective, now - windowDays * DAY, { version: 'v-f1', versionContentRef: 'f1' });
const count = await runtime.objectiveTraces.countWindow(owner, objective, now - windowDays * DAY, now);
const trigger = await runtime.cycleChecker.checkObjective(owner, objective, now);
console.log(
  JSON.stringify({
    step: 'trigger',
    shrunkOthers: shrunk,
    windowTraces: count,
    status: trigger.status,
    triggeredBy: trigger.record.triggeredBy,
    cycleId: trigger.record.cycleId,
  }),
);
if (trigger.status !== 'requested') {
  await redis.quit();
  process.exit(2);
}

// 3) Wait for the production path: assignment (API reconcile ≤60 s) → real cat → structured writeback.
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < timeoutMin * 60 * 1000) {
  const rec = JSON.parse(await redis.get(key(objective)));
  const line = `${rec.evalStatus}${rec.assignedAt ? ' assigned' : ''}${rec.retriggeredAt ? ' retriggered' : ''}`;
  if (line !== last) {
    console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), state: line }));
    last = line;
  }
  if (rec.evalStatus === 'written' || rec.evalStatus === 'stalled') {
    const ev = rec.evaluation;
    console.log(
      JSON.stringify({
        step: 'done',
        evalStatus: rec.evalStatus,
        by: ev?.by,
        overall: ev?.overall,
        writebackAfterAssignmentSec: ev && rec.assignedAt ? Math.round((ev.writtenAt - rec.assignedAt) / 1000) : null,
        metrics: ev?.metrics?.map((m) => ({
          id: m.id,
          kind: m.conclusion.kind,
          value: m.conclusion.value ?? m.conclusion.count,
          evidenceRefs: m.evidenceRefs.length,
        })),
        bytes: Buffer.byteLength(JSON.stringify(rec)),
      }),
    );
    await redis.quit();
    process.exit(rec.evalStatus === 'written' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log(JSON.stringify({ step: 'timeout', minutes: timeoutMin }));
await redis.quit();
process.exit(1);
