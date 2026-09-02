#!/usr/bin/env node
// F-5 dynamic falsifier for S3 on the ISOLATED stack only. Drives evaluation/governance writebacks in-process
// (built coordinators, real Redis stores) and exercises approve/skip/reject through the isolated API's HTTP routes
// so registry reload + snapshot refresh happen in the API process.
// Usage: node iso-cycle-s3-exercise.mjs --gate <worktree-with-dist> --redis-url redis://127.0.0.1:6378 --api-url http://127.0.0.1:3122 [--owner default-user]
import { readFile } from 'node:fs/promises';
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
const objectiveArg = args.get('--objective');
const objective2Arg = args.get('--objective2');
if (!gate || !redisUrl || !apiUrl) throw new Error('usage: --gate <dir> --redis-url <url> --api-url <url>');
if (FORBIDDEN_PORTS.has(new URL(redisUrl).port) || FORBIDDEN_PORTS.has(new URL(apiUrl).port))
  throw new Error('refusing runtime/sanctum ports');

const req = createRequire(join(gate, 'package.json'));
const Redis = (await import(req.resolve('ioredis'))).default;
const dist = (rel) => pathToFileURL(join(gate, 'packages/api/dist', rel)).href;
const { ObjectiveEvaluationRuntime } = await import(
  dist('infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js')
);
const { CycleEvaluationCoordinator } = await import(
  dist('infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js')
);
const { CycleGovernanceCoordinator } = await import(
  dist('infrastructure/harness-eval/governance/CycleGovernanceCoordinator.js')
);
const { HarnessGovernanceExecutor } = await import(
  dist('infrastructure/harness-eval/governance/HarnessGovernanceExecutor.js')
);
const { HarnessGovernanceProposalStore } = await import(
  dist('infrastructure/harness-eval/governance/HarnessGovernanceProposalStore.js')
);
const { loadEvaluationCatalog } = await import(dist('infrastructure/harness-eval/evaluation/evaluation-catalog.js'));
const { TraceAnnotationStore } = await import(
  dist('infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js')
);
const { InjectionTraceStore } = await import(dist('domains/prompt-hooks/InjectionTraceStore.js'));
const { createThreadStore } = await import(dist('domains/cats/services/stores/factories/ThreadStoreFactory.js'));
const { HookRegistry } = await import(dist('domains/prompt-hooks/HookRegistry.js'));
const { HookOverrideStore } = await import(dist('domains/prompt-hooks/HookOverrideStore.js'));

const redis = new Redis(redisUrl, { keyPrefix: 'cat-cafe:', maxRetriesPerRequest: 3 });
const catalogResult = await loadEvaluationCatalog(gate);
if (!catalogResult.ok) throw new Error(catalogResult.error);
const catalog = catalogResult.catalog;
const registry = new HookRegistry(join(gate, 'assets', 'prompt-hooks'), join(gate, 'assets', 'prompt-templates'));
registry.scan();
const overrideStore = new HookOverrideStore(redis, (hookId) => registry.getHook(hookId)?.manifest);
const syncRegistry = async () => registry.setOverrideSnapshot(await overrideStore.loadSnapshot());
await syncRegistry();
const version = { version: 'v-s3', versionContentRef: 's3' };
const runtime = new ObjectiveEvaluationRuntime(redis, catalog, new TraceAnnotationStore(redis), {
  traceStore: new InjectionTraceStore(redis),
  resolveVersion: () => version,
});
const clock = Date.now();
const delivered = [];
const evaluation = new CycleEvaluationCoordinator({
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
    return `msg-s3-${delivered.length}`;
  },
  getInvokeTrigger: () => ({ trigger: async () => 'dispatched' }),
  getDefaultCatId: () => 'codex-sol',
  now: () => clock,
});
const proposals = new HarnessGovernanceProposalStore(redis);
const executor = new HarnessGovernanceExecutor({
  catalog,
  overrideStore,
  getRegistry: () => registry,
  reloadPipeline: syncRegistry,
});
let quiescent = true;
let governance = null; // constructed later so the API process owns the FIRST governance assignment (real path)
const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail).slice(0, 700)}`);
};
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const key = (o) => `harness-cycle-current:${owner}:${o}`;
const current = (o) => runtime.cycles.current(owner, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs, stepMs = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const value = await predicate();
    if (value) return { value, ms: Date.now() - t0 };
    await sleep(stepMs);
  }
  return { value: null, ms: Date.now() - t0 };
};

// ---- isolated API HTTP client (owner session via loopback bootstrap)
const jar = new Map();
async function http(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  for (const c of response.headers.getSetCookie()) {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
await http('/api/session');
const threadMessages = async (threadId) =>
  (await http(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=50`)).body?.messages ?? [];
const jsonBlock = (content) => {
  const m = (content ?? '').match(/```json\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
};

// ---- unit selection for identity-truth: one modifiable (not readonly), one disableable.
const objective = objectiveArg ?? 'identity-truth';
const units = catalog.manifest.units
  .filter((u) => u.objectives.some((o) => o.objectiveId === objective))
  .map((u) => u.unitId);
const hookOf = (id) => registry.getHook(id);
const modifiable = units.find((id) => hookOf(id) && hookOf(id).manifest.safetyTier !== 'readonly');
const disableable = units.find((id) => hookOf(id)?.manifest.disableable);
if (!modifiable) throw new Error(`no modifiable unit for ${objective}: ${units.join(',')}`);
const effectiveContent = async (id) =>
  registry.getContentOverride(id) ?? (await readFile(hookOf(id).templatePath, 'utf8'));
const metricsFor = (objectiveId) => {
  const model = catalog.registry.evaluationModels.find(
    (m) => m.id === catalog.registry.objectives.find((o) => o.id === objectiveId).evaluationModelId,
  );
  return model.metrics;
};
const conclusionFor = (metric) =>
  metric.kind === 'rate'
    ? { kind: 'rate-badness', value: 0, howCounted: 's3 exercise' }
    : metric.kind === 'semantic'
      ? { kind: 'semantic-label', label: 'consistent', count: 1, howCounted: 's3 exercise' }
      : { kind: 'count', value: 0, howCounted: 's3 exercise' };
const principal = (objectiveId) => ({ userId: owner, catId: 'codex-sol', threadId: `thread_eval_f257_${objectiveId}` });
async function freshCycle(objectiveId, windowDays) {
  await redis.del(key(objectiveId));
  await runtime.cycles.initialize(owner, objectiveId, Date.now() - windowDays * DAY, version);
  const r = await runtime.cycleChecker.checkObjective(owner, objectiveId, Date.now());
  if (r.status !== 'requested') throw new Error(`${objectiveId} not requested: ${r.status}`);
  return r.record;
}
async function writeEvaluation(objectiveId, cycleId) {
  const rec = await current(objectiveId);
  const refs = (await runtime.objectiveTraces.invocationIds(owner, objectiveId, rec.windows)).slice(0, 2);
  return evaluation.submitEvaluation(principal(objectiveId), {
    objectiveId,
    cycleId,
    metrics: metricsFor(objectiveId).map((m) => ({ id: m.id, conclusion: conclusionFor(m), evidenceRefs: refs })),
    overall: 'complete',
  });
}

// ---- A: written → API delivers the governance assignment (real production path, ≤ 60 s)
const c1 = await freshCycle(objective, 2);
const assigned = await waitFor(async () => ((await current(objective)).assignedAt ? true : null), 90 * 1000);
record('A0 eval assignment delivered by the API after request', !!assigned.value, { ms: assigned.ms });
const ev1 = await writeEvaluation(objective, c1.cycleId);
const writtenAt = Date.now();
const govAssigned = await waitFor(async () => {
  const r = await current(objective);
  return r.governanceAssignedAt ? r : null;
}, 120 * 1000);
const govMsg = govAssigned.value
  ? (await threadMessages(`thread_eval_f257_${objective}`)).find(
      (m) => m.id === govAssigned.value.governanceAssignmentMessageId,
    )
  : null;
const govJson = govMsg ? jsonBlock(govMsg.content) : null;
record(
  'F-5a governance assignment in the same Objective thread ≤ 5 min after written (API path)',
  ev1.outcome === 'written' &&
    !!govAssigned.value &&
    !!govMsg &&
    Buffer.byteLength(govMsg.content) <= 32 * 1024 &&
    !!govJson?.history &&
    !!govJson?.writebackTool &&
    !/inputText|outputText|traceCorpus/.test(govMsg.content),
  {
    secondsAfterWritten: Math.round(govAssigned.ms / 1000),
    bytes: govMsg ? Buffer.byteLength(govMsg.content) : null,
    keys: govJson ? Object.keys(govJson) : null,
    historyLen: govJson?.history?.length,
  },
);

// ---- B0: protected (readonly/immutable) units never get a card — hydrate must refuse modify/disable
let protectedRefusal = null;
try {
  await executor.hydrate('identity-truth', {
    objectiveId: 'identity-truth',
    cycleId: 'x',
    decision: 'evolve',
    reason: 'x',
    v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'x', proposedContent: 'tampered' }] },
  });
} catch (error) {
  protectedRefusal = error.message;
}
let protectedDisable = null;
try {
  await executor.hydrate('identity-truth', {
    objectiveId: 'identity-truth',
    cycleId: 'x',
    decision: 'evolve',
    reason: 'x',
    v2Draft: { changes: [{ action: 'disable', unitId: 'D1', reason: 'x' }] },
  });
} catch (error) {
  protectedDisable = error.message;
}
record(
  'B0 protected unit (D1 readonly/immutable): modify and disable drafts are refused fail-closed',
  /modify_forbidden/.test(protectedRefusal ?? '') && /disable_forbidden/.test(protectedDisable ?? ''),
  { modify: protectedRefusal, disable: protectedDisable },
);

// ---- B: evolve → durable proposal + pending card (F276 adapter), exact retry idempotent
governance = new CycleGovernanceCoordinator({
  runtime,
  evaluation,
  proposals,
  executor,
  isThreadQuiescent: async () => quiescent,
  now: () => clock,
});
const before1 = await effectiveContent(modifiable);
const draft1 = {
  changes: [
    {
      action: 'modify',
      unitId: modifiable,
      reason: 's3 gate: clarify identity anchor',
      proposedContent: `${before1.trimEnd()}\n\n<!-- f257 s3 gate exercise v2 -->\n`,
    },
  ],
};
const g1 = await governance.submitGovernance(principal(objective), {
  objectiveId: objective,
  cycleId: c1.cycleId,
  decision: 'evolve',
  reason: 's3 gate: evolve identity anchor wording',
  v2Draft: draft1,
});
const g1retry = await governance.submitGovernance(principal(objective), {
  objectiveId: objective,
  cycleId: c1.cycleId,
  decision: 'evolve',
  reason: 's3 gate: evolve identity anchor wording',
  v2Draft: draft1,
});
const pending1 =
  (await http('/api/approval-hub/pending')).body?.items?.filter((i) => i.sourceFeatureId === 'F257') ?? [];
const card1 = pending1.find((i) => i.proposalId === g1.proposalId);
const d1 = card1?.detail ?? {};
const fiveSections = ['header', 'conclusions', 'history', 'changes', 'evidenceRefs'].every((k) => d1[k] !== undefined);
record(
  'F-5b evolve → durable proposal + pending card with §5.1 sections; exact retry returns the same proposalId',
  g1.outcome === 'written' &&
    g1retry.outcome === 'already_written' &&
    g1retry.proposalId === g1.proposalId &&
    !!card1 &&
    card1.decisionMode === 'approve-skip-reject' &&
    fiveSections &&
    d1.cardOrdinal === 1 &&
    d1.changes?.[0]?.action === 'modify' &&
    typeof d1.changes[0].beforeContent === 'string' &&
    typeof d1.changes[0].proposedContent === 'string' &&
    d1.evidenceRefs.length > 0,
  {
    proposalId: g1.proposalId,
    retry: g1retry.outcome,
    pendingF257: pending1.length,
    decisionMode: card1?.decisionMode,
    cardOrdinal: d1.cardOrdinal,
    changeKeys: d1.changes ? Object.keys(d1.changes[0]) : null,
    evidenceRefs: d1.evidenceRefs?.length,
  },
);

// ---- C: reject (reason required) → same frozen windows re-evaluated, next card generation
const rejectNoReason = await http(`/api/harness-governance-candidates/${g1.proposalId}/reject`, {
  method: 'POST',
  body: JSON.stringify({}),
});
const rejected = await http(`/api/harness-governance-candidates/${g1.proposalId}/reject`, {
  method: 'POST',
  body: JSON.stringify({ note: 's3 gate: draft too vague, re-evaluate' }),
});
const afterReject = await current(objective);
const reassigned = await waitFor(async () => {
  const r = await current(objective);
  return r.evalStatus === 'requested' && r.assignedAt ? r : null;
}, 120 * 1000);
const reMsg = reassigned.value
  ? (await threadMessages(`thread_eval_f257_${objective}`)).find((m) => m.id === reassigned.value.assignmentMessageId)
  : null;
const reJson = reMsg ? jsonBlock(reMsg.content) : null;
record(
  'F-5c reject requires a reason; same frozen windows re-evaluated with rejectReasons; new assignment delivered (API path)',
  rejectNoReason.status === 400 &&
    rejected.status === 200 &&
    rejected.body?.proposal?.status === 'rejected' &&
    afterReject.evalStatus === 'requested' &&
    afterReject.approval?.state === 'rejected' &&
    afterReject.approval.rejectCount === 1 &&
    JSON.stringify(afterReject.windows) === JSON.stringify(c1.windows) &&
    !!reMsg &&
    Array.isArray(reJson?.rejectReasons) &&
    reJson.rejectReasons[0] === 's3 gate: draft too vague, re-evaluate',
  {
    noReasonStatus: rejectNoReason.status,
    rejectStatus: rejected.status,
    evalStatus: afterReject.evalStatus,
    rejectCount: afterReject.approval?.rejectCount,
    reassignMs: reassigned.ms,
    rejectReasons: reJson?.rejectReasons,
  },
);
const ev2 = await writeEvaluation(objective, c1.cycleId);
await sleep(1500);
const before2 = await effectiveContent(modifiable);
const addUnit = {
  unitId: 'X1',
  assetSlug: 'x1-f257-gate-exercise',
  manifest: {
    id: 'X1',
    name: 'F257 gate exercise unit',
    stage: 'per-turn',
    order: 990,
    version: 1,
    enabled: true,
    template: 'x1-f257-gate-exercise.md',
    inputs: [],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'auto-evolve',
  },
  content: '# F257 gate exercise\n\nThis unit exists only on the isolated stack.\n',
  objectives: [{ objectiveId: objective }],
};
const g2 = await governance.submitGovernance(principal(objective), {
  objectiveId: objective,
  cycleId: c1.cycleId,
  decision: 'evolve',
  reason: 's3 gate: second draft after rejection',
  v2Draft: {
    changes: [
      {
        action: 'modify',
        unitId: modifiable,
        reason: 'second draft',
        proposedContent: `${before2.trimEnd()}\n\n<!-- f257 s3 gate exercise v2 (card 2) -->\n`,
      },
      { action: 'add', reason: 'add exercise unit', unit: addUnit },
    ],
  },
});
const card2 = ((await http('/api/approval-hub/pending')).body?.items ?? []).find((i) => i.proposalId === g2.proposalId);
record(
  'F-5d after re-evaluation the next governance produces a NEW card (generation 2)',
  ev2.outcome === 'written' &&
    g2.outcome === 'written' &&
    g2.proposalId !== g1.proposalId &&
    card2?.detail?.cardOrdinal === 2 &&
    (card2?.detail?.rejectReasons ?? []).length === 1,
  { proposalId: g2.proposalId, cardOrdinal: card2?.detail?.cardOrdinal, rejectReasons: card2?.detail?.rejectReasons },
);

// ---- D: approve via the API → overlay applied + unit added + registry reload + cycle advanced on v2
const versionBefore = (await http(`/api/prompt-hooks/${modifiable}/versions`)).body;
const approved = await http(`/api/harness-governance-candidates/${g2.proposalId}/approve`, {
  method: 'POST',
  body: JSON.stringify({ note: 's3 gate approve' }),
});
const versionAfter = (await http(`/api/prompt-hooks/${modifiable}/versions`)).body;
const overridesAfter = (await http('/api/prompt-hooks/overrides')).body;
await syncRegistry();
const contentAfter = await effectiveContent(modifiable);
const archived = await runtime.cycles.historyCycle(owner, objective, c1.cycleId);
const nextCycle = await current(objective);
const addedLifeline = await http('/api/segment-lifeline/X1');
const activeVersion = (body) =>
  body?.activeVersion ??
  body?.current?.version ??
  body?.active ??
  (Array.isArray(body?.versions) ? body.versions.find((v) => v.current || v.active)?.version : undefined);
record(
  'F-5e approve applies the overlay + adds the unit, API registry reloaded, cycle archived as approved and advanced on the new version',
  approved.status === 200 &&
    contentAfter.includes('f257 s3 gate exercise v2 (card 2)') &&
    archived?.approval?.state === 'approved' &&
    archived.approval.rejectCount === 1 &&
    nextCycle?.evalStatus === 'idle' &&
    nextCycle.cycleStart === archived.cycleEnd &&
    nextCycle.versionContentRef !== c1.versionContentRef &&
    addedLifeline.status === 200,
  {
    approveStatus: approved.status,
    versionBefore: activeVersion(versionBefore),
    versionAfter: activeVersion(versionAfter),
    overridesForUnit: Array.isArray(overridesAfter)
      ? overridesAfter.filter((o) => o.hookId === modifiable).length
      : (overridesAfter?.overrides ?? []).filter((o) => o.hookId === modifiable).length,
    archivedState: archived?.approval?.state,
    nextCycleStartEqPrevEnd: nextCycle?.cycleStart === archived?.cycleEnd,
    nextVersionRef: nextCycle?.versionContentRef,
    X1lifeline: addedLifeline.status,
  },
);

// ---- E: skip advances on the existing version (disable draft on a second objective); keep closes without a card
const objective2 = objective2Arg ?? 'tool-access-correct-use';
const c2 = await freshCycle(objective2, 2);
await waitFor(async () => ((await current(objective2)).assignedAt ? true : null), 90 * 1000);
await writeEvaluation(objective2, c2.cycleId);
await sleep(1500);
const units2 = catalog.manifest.units
  .filter((u) => u.objectives.some((o) => o.objectiveId === objective2))
  .map((u) => u.unitId);
const disableable2 = units2.find((id) => hookOf(id)?.manifest.disableable);
const g3 = await governance.submitGovernance(principal(objective2), {
  objectiveId: objective2,
  cycleId: c2.cycleId,
  decision: 'evolve',
  reason: 's3 gate: propose disable',
  v2Draft: { changes: [{ action: 'disable', unitId: disableable2, reason: 'exercise' }] },
});
const skipped = await http(`/api/harness-governance-candidates/${g3.proposalId}/skip`, {
  method: 'POST',
  body: JSON.stringify({ note: 's3 gate skip' }),
});
await syncRegistry();
const archived2 = await runtime.cycles.historyCycle(owner, objective2, c2.cycleId);
const next2 = await current(objective2);
record(
  'F-5f skip settles the card, keeps the version and advances the cycle',
  skipped.status === 200 &&
    archived2?.approval?.state === 'skipped' &&
    next2?.evalStatus === 'idle' &&
    next2.versionContentRef === c2.versionContentRef &&
    registry.isEnabled(disableable2),
  {
    skipStatus: skipped.status,
    archivedState: archived2?.approval?.state,
    versionUnchanged: next2?.versionContentRef === c2.versionContentRef,
    unitStillEnabled: registry.isEnabled(disableable2),
  },
);
const objective3 = 'capability-guide-wakeup';
const c3 = await freshCycle(objective3, 2);
await waitFor(async () => ((await current(objective3)).assignedAt ? true : null), 90 * 1000);
await writeEvaluation(objective3, c3.cycleId);
await sleep(1500);
const pendingBeforeKeep = ((await http('/api/approval-hub/pending')).body?.items ?? []).filter(
  (i) => i.sourceFeatureId === 'F257',
).length;
const g4 = await governance.submitGovernance(principal(objective3), {
  objectiveId: objective3,
  cycleId: c3.cycleId,
  decision: 'keep',
  reason: 's3 gate: keep',
});
const pendingAfterKeep = ((await http('/api/approval-hub/pending')).body?.items ?? []).filter(
  (i) => i.sourceFeatureId === 'F257',
).length;
const archived3 = await runtime.cycles.historyCycle(owner, objective3, c3.cycleId);
record(
  'F-5g keep closes the cycle immediately without any card',
  g4.outcome === 'written' &&
    g4.decision === 'keep' &&
    !!g4.nextCycleId &&
    archived3?.governance?.decision === 'keep' &&
    pendingAfterKeep === pendingBeforeKeep,
  {
    outcome: g4.outcome,
    nextCycleId: !!g4.nextCycleId,
    pendingBefore: pendingBeforeKeep,
    pendingAfter: pendingAfterKeep,
  },
);

// ---- F: TC-16 daily reminder while quiescent and no card
const objective4 = 'continuation-memory-recovery';
const c4 = await freshCycle(objective4, 2);
await waitFor(async () => ((await current(objective4)).assignedAt ? true : null), 90 * 1000);
await writeEvaluation(objective4, c4.cycleId);
await sleep(1500);
const deliveredBefore = delivered.length;
const remindersOf = () =>
  delivered.slice(deliveredBefore).filter((d) => d.idempotencyKey.includes('governance-reminder'));
quiescent = false;
await governance.reconcileKnownCycles(clock + 25 * 60 * MIN);
const noneWhileBusy = remindersOf().length;
quiescent = true;
await governance.reconcileKnownCycles(clock + 25 * 60 * MIN);
const first = remindersOf().length;
await governance.reconcileKnownCycles(clock + 26 * 60 * MIN);
const sameDay = remindersOf().length;
await governance.reconcileKnownCycles(clock + 50 * 60 * MIN);
const nextDay = remindersOf().length;
record(
  'F-5h TC-16 missing-card reminder: none while thread busy, once per day while quiescent',
  noneWhileBusy === 0 && first === 1 && sameDay === 1 && nextDay === 2,
  { noneWhileBusy, first, sameDay, nextDay },
);

await redis.quit();
console.log(
  JSON.stringify({
    summary: { pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length },
    modifiable,
    disableable,
  }),
);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
