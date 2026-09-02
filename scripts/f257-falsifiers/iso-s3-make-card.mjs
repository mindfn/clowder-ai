#!/usr/bin/env node
// Create one pending F257 governance card on the ISOLATED stack (for §5.1 visual acceptance).
// Usage: node iso-s3-make-card.mjs --gate <dir> --redis-url redis://127.0.0.1:6378 --api-url http://127.0.0.1:3122 --objective routing-target-delivery --unit C1
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
const objective = args.get('--objective');
const unitId = args.get('--unit');
if (!gate || !redisUrl || !apiUrl || !objective || !unitId)
  throw new Error('usage: --gate --redis-url --api-url --objective --unit');
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
const redis = new Redis(redisUrl, { keyPrefix: 'cat-cafe:' });
const catalog = (await loadEvaluationCatalog(gate)).catalog;
const registry = new HookRegistry(join(gate, 'assets', 'prompt-hooks'), join(gate, 'assets', 'prompt-templates'));
registry.scan();
const overrideStore = new HookOverrideStore(redis, (id) => registry.getHook(id)?.manifest);
registry.setOverrideSnapshot(await overrideStore.loadSnapshot());
const version = { version: 'v-card', versionContentRef: 'card' };
const runtime = new ObjectiveEvaluationRuntime(redis, catalog, new TraceAnnotationStore(redis), {
  traceStore: new InjectionTraceStore(redis),
  resolveVersion: () => version,
});
const evaluation = new CycleEvaluationCoordinator({
  runtime,
  threadStore: createThreadStore(redis),
  messageStore: { getByIds: async () => [] },
  deliver: async () => 'msg-card',
  getInvokeTrigger: () => ({ trigger: async () => 'dispatched' }),
  getDefaultCatId: () => 'codex-sol',
});
const governance = new CycleGovernanceCoordinator({
  runtime,
  evaluation,
  proposals: new HarnessGovernanceProposalStore(redis),
  executor: new HarnessGovernanceExecutor({
    catalog,
    overrideStore,
    getRegistry: () => registry,
    reloadPipeline: async () => registry.setOverrideSnapshot(await overrideStore.loadSnapshot()),
  }),
  isThreadQuiescent: async () => true,
});
const key = `harness-cycle-current:${owner}:${objective}`;
const DAY = 864e5;
await redis.del(key);
await runtime.cycles.initialize(owner, objective, Date.now() - 2 * DAY, version);
const r = await runtime.cycleChecker.checkObjective(owner, objective, Date.now());
if (r.status !== 'requested') throw new Error(`not requested: ${r.status}`);
const wait = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await new Promise((x) => setTimeout(x, 2000));
  }
  return null;
};
await wait(async () => (await runtime.cycles.current(owner, objective)).assignedAt, 90e3);
const rec = await runtime.cycles.current(owner, objective);
const refs = (await runtime.objectiveTraces.invocationIds(owner, objective, rec.windows)).slice(0, 3);
const model = catalog.registry.evaluationModels.find(
  (m) => m.id === catalog.registry.objectives.find((o) => o.id === objective).evaluationModelId,
);
const conclusionFor = (m) =>
  m.kind === 'rate'
    ? { kind: 'rate-badness', value: 0.1, howCounted: 'card demo' }
    : m.kind === 'semantic'
      ? { kind: 'semantic-label', label: 'drift', count: 2, howCounted: 'card demo' }
      : { kind: 'count', value: 3, howCounted: 'card demo' };
const principal = { userId: owner, catId: 'codex-sol', threadId: `thread_eval_f257_${objective}` };
await evaluation.submitEvaluation(principal, {
  objectiveId: objective,
  cycleId: r.record.cycleId,
  metrics: model.metrics.map((m) => ({ id: m.id, conclusion: conclusionFor(m), evidenceRefs: refs })),
  overall: 'complete',
});
await wait(async () => (await runtime.cycles.current(owner, objective)).governanceAssignedAt, 120e3);
const before = registry.getContentOverride(unitId) ?? (await readFile(registry.getHook(unitId).templatePath, 'utf8'));
const proposed = `${before.trimEnd()}\n\n<!-- v2 draft: 明示目标不一致时先复核 @ 解析再投递（F257 卡片演示） -->\n`;
const g = await governance.submitGovernance(principal, {
  objectiveId: objective,
  cycleId: r.record.cycleId,
  decision: 'evolve',
  reason: '本周期 3 次明示目标与实际送达不一致，建议在段内补一条复核规则',
  v2Draft: { changes: [{ action: 'modify', unitId, reason: '补充复核规则', proposedContent: proposed }] },
});
console.log(JSON.stringify({ proposalId: g.proposalId, outcome: g.outcome, cycleId: r.record.cycleId }));
await redis.quit();
