#!/usr/bin/env node
// F-3 / F-4 dynamic falsifier for S2 on the ISOLATED stack only (drives the built coordinator with clock fixtures).
// Usage: node iso-cycle-s2-exercise.mjs --gate <worktree-with-dist> --redis-url redis://127.0.0.1:6378 [--owner default-user]
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
const checks = new Set((args.get('--checks') ?? 'F-3,F-4').split(','));
if (!gate || !redisUrl) throw new Error('usage: --gate <worktree> --redis-url <url> [--owner id]');
if (FORBIDDEN_PORTS.has(new URL(redisUrl).port)) throw new Error(`refusing runtime/sanctum redis ${redisUrl}`);

const req = createRequire(join(gate, 'package.json'));
const Redis = (await import(req.resolve('ioredis'))).default;
const dist = (rel) => pathToFileURL(join(gate, 'packages/api/dist', rel)).href;
const { ObjectiveEvaluationRuntime } = await import(
  dist('infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js')
);
const { CycleEvaluationCoordinator } = await import(
  dist('infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js')
);
const { loadEvaluationCatalog } = await import(dist('infrastructure/harness-eval/evaluation/evaluation-catalog.js'));
const { TraceAnnotationStore } = await import(
  dist('infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js')
);
const { InjectionTraceStore } = await import(dist('domains/prompt-hooks/InjectionTraceStore.js'));
const { createThreadStore } = await import(dist('domains/cats/services/stores/factories/ThreadStoreFactory.js'));

const redis = new Redis(redisUrl, { keyPrefix: 'cat-cafe:', maxRetriesPerRequest: 3 });
const catalogResult = await loadEvaluationCatalog(gate);
if (!catalogResult.ok) throw new Error(catalogResult.error);
const runtime = new ObjectiveEvaluationRuntime(redis, catalogResult.catalog, new TraceAnnotationStore(redis), {
  traceStore: new InjectionTraceStore(redis),
  resolveVersion: () => ({ version: 'v-exercise', versionContentRef: 'exercise' }),
});
let clock = Date.now();
const delivered = [];
const coordinator = new CycleEvaluationCoordinator({
  runtime,
  threadStore: createThreadStore(redis),
  messageStore: { getByIds: async () => [] },
  deliver: async (input) => {
    delivered.push({
      threadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      bytes: Buffer.byteLength(input.content),
      content: input.content,
    });
    return `msg-exercise-${delivered.length}`;
  },
  getInvokeTrigger: () => ({ trigger: async () => 'dispatched' }),
  getDefaultCatId: () => 'codex',
  now: () => clock,
});
const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail).slice(0, 600)}`);
};
const MIN = 60 * 1000;
const current = (objective) => runtime.cycles.current(owner, objective);

// ---- F-3: per requested cycle exactly one retrigger, then exactly one stalled alert, then silence.
// (The API process may have requested several Objectives via the per-trace path; count per cycle.)
const objectives = catalogResult.catalog.registry.objectives.map((o) => o.id);
const requestedNow = [];
if (checks.has('F-3'))
  for (const objectiveId of objectives) {
    const rec = await current(objectiveId);
    if (rec?.evalStatus === 'requested' && rec.assignedAt !== undefined)
      requestedNow.push({ objectiveId, assignedAt: rec.assignedAt, cycleId: rec.cycleId });
  }
if (checks.has('F-3') && requestedNow.length === 0) throw new Error('no assigned requested cycles to exercise F-3');
if (checks.has('F-3')) {
  const A = Math.max(...requestedNow.map((r) => r.assignedAt));
  const byKind = (kind) => delivered.filter((d) => d.idempotencyKey.endsWith(`:${kind}`));
  const perCycle = (kind) =>
    new Map(
      byKind(kind)
        .map((d) => [d.idempotencyKey, 0])
        .map(([k]) => [k, byKind(kind).filter((d) => d.idempotencyKey === k).length]),
    );
  const statuses = async () =>
    Object.fromEntries(
      await Promise.all(requestedNow.map(async (r) => [r.objectiveId, (await current(r.objectiveId)).evalStatus])),
    );
  await coordinator.reconcileKnownCycles(A + 29 * MIN);
  record(
    'F-3a no retrigger before 30 min',
    delivered.length === 0 && Object.values(await statuses()).every((s) => s === 'requested'),
    { requestedCycles: requestedNow.length },
  );
  await coordinator.reconcileKnownCycles(A + 31 * MIN);
  const st1 = await statuses();
  record(
    'F-3b exactly one retrigger per cycle at +31 min (objective threads)',
    byKind('retrigger').length === requestedNow.length &&
      [...perCycle('retrigger').values()].every((n) => n === 1) &&
      byKind('stalled').length === 0 &&
      Object.values(st1).every((s) => s === 'retriggered') &&
      byKind('retrigger').every((d) => d.threadId.startsWith('thread_eval_f257_')),
    { retriggers: byKind('retrigger').length, cycles: requestedNow.length, statuses: st1 },
  );
  await coordinator.reconcileKnownCycles(A + 45 * MIN);
  record(
    'F-3c no second retrigger at +45 min',
    byKind('retrigger').length === requestedNow.length && byKind('stalled').length === 0,
    { retriggers: byKind('retrigger').length },
  );
  await coordinator.reconcileKnownCycles(A + 62 * MIN);
  const st2 = await statuses();
  record(
    'F-3d exactly one stalled alert per cycle at +62 min (hub thread)',
    byKind('stalled').length === requestedNow.length &&
      [...perCycle('stalled').values()].every((n) => n === 1) &&
      byKind('stalled').every((d) => d.threadId === 'thread_eval_harness_ledger') &&
      Object.values(st2).every((s) => s === 'stalled'),
    { stalled: byKind('stalled').length, statuses: st2 },
  );
  await coordinator.reconcileKnownCycles(A + 240 * MIN);
  record(
    'F-3e no further retry after stalled (+240 min)',
    delivered.length === 2 * requestedNow.length && Object.values(await statuses()).every((s) => s === 'stalled'),
    { delivered: delivered.length },
  );
}

// ---- F-4: insufficient_evidence archives the cycle, next cycle starts at prior cycleEnd, next assignment carries the skip window + reason.
const DAY = 24 * 60 * 60 * 1000;
// F-4 fixture (deterministic, iso-only): reset identity-truth to a fresh idle cycle starting 6 days ago;
// first cycle requests at T0 = now-3d (≈480 traces), is skipped, the next cycle must request now (≈480 traces) with the skip window.
const objective = 'identity-truth';
const T0 = Date.now() - 3 * DAY;
if (checks.has('F-4')) {
  const histKeys = await (async () => {
    const out = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `cat-cafe:harness-cycle-history:${owner}:${objective}:*`,
        'COUNT',
        500,
      );
      cursor = String(next);
      out.push(...batch.map((k) => k.replace(/^cat-cafe:/, '')));
    } while (cursor !== '0');
    return out;
  })();
  await redis.del(
    `harness-cycle-current:${owner}:${objective}`,
    `harness-cycle-history-index:${owner}:${objective}`,
    ...histKeys,
  );
  await runtime.cycles.initialize(owner, objective, Date.now() - 6 * DAY, {
    version: 'v-exercise',
    versionContentRef: 'exercise',
  });
}
if (checks.has('F-4')) {
  const first = await runtime.cycleChecker.checkObjective(owner, objective, T0);
  record(
    `F-4a first cycle (${objective}) requested with cycleEnd = T0`,
    first.status === 'requested' && first.record.cycleEnd === T0,
    { status: first.status, triggeredBy: first.record.triggeredBy },
  );
  const model = catalogResult.catalog.registry.evaluationModels.find(
    (m) => m.id === catalogResult.catalog.registry.objectives.find((o) => o.id === objective).evaluationModelId,
  );
  const conclusionFor = (metric) =>
    metric.kind === 'rate'
      ? { kind: 'rate-badness', value: 0, howCounted: 'exercise' }
      : metric.kind === 'semantic'
        ? { kind: 'semantic-label', label: 'insufficient', count: 0, howCounted: 'exercise' }
        : { kind: 'count', value: 0, howCounted: 'exercise' };
  const principal = { userId: owner, catId: 'codex', threadId: `thread_eval_f257_${objective}` };
  const body = () => ({
    objectiveId: objective,
    cycleId: first.record.cycleId,
    metrics: model.metrics.map((m) => ({ id: m.id, conclusion: conclusionFor(m), evidenceRefs: [] })),
    overall: 'insufficient_evidence',
  });
  clock = T0 + 60 * MIN;
  const submission = await coordinator.submitEvaluation(principal, body());
  const afterSkip = await current(objective);
  const archived = await runtime.cycles.historyCycle(owner, objective, first.record.cycleId);
  record(
    'F-4b insufficient_evidence archived + next idle cycle starts at prior cycleEnd',
    submission.outcome === 'written' &&
      afterSkip.evalStatus === 'idle' &&
      afterSkip.cycleStart === T0 &&
      archived?.evaluation?.overall === 'insufficient_evidence' &&
      archived.closedAt === clock,
    {
      outcome: submission.outcome,
      nextCycleStart: afterSkip.cycleStart,
      archivedOverall: archived?.evaluation?.overall,
    },
  );
  const retry = await coordinator.submitEvaluation(principal, body());
  record('F-4c exact retry of the archived writeback is idempotent', retry.outcome === 'already_written', {
    outcome: retry.outcome,
  });
  clock = Date.now();
  const beforeCount = delivered.length;
  const second = await runtime.cycleChecker.checkObjective(owner, objective, Date.now());
  await new Promise((r) => setTimeout(r, 2000));
  const assignment = delivered.find(
    (d) => d.idempotencyKey === `f257-cycle:${owner}:${second.record.cycleId}:assignment`,
  );
  const parsed = assignment ? JSON.parse(assignment.content.match(/```json\n([\s\S]*?)\n```/)[1]) : null;
  const skipWindowIncluded =
    !!parsed && parsed.windows.length === 2 && parsed.windows[0].end === T0 && parsed.windows[1].start === T0;
  record(
    'F-4d next assignment carries windows[skip, current] + priorSkipReasons (≤32 KB, refs only)',
    second.status === 'requested' &&
      !!assignment &&
      assignment.bytes <= 32 * 1024 &&
      skipWindowIncluded &&
      Array.isArray(parsed.priorSkipReasons) &&
      parsed.priorSkipReasons[0]?.cycleId === first.record.cycleId &&
      parsed.priorSkipReasons[0]?.reason === 'insufficient_evidence' &&
      !/traceCorpus|inputText|outputText/.test(assignment.content),
    {
      status: second.status,
      recordWindows: second.record.windows,
      windows: parsed?.windows,
      priorSkipReasons: parsed?.priorSkipReasons,
      bytes: assignment?.bytes,
      counterexamples: parsed?.counterexamples?.length,
      deliveredKeys: delivered
        .slice(beforeCount)
        .map((d) => d.idempotencyKey.split(':').slice(2).join(':').slice(0, 30)),
    },
  );
}

await redis.quit();
console.log(
  JSON.stringify({ summary: { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length } }),
);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
