'use client';

import type { SegmentEvaluationResponse } from '@cat-cafe/shared';
import { ObjectiveEvaluationPanel } from '@/components/settings/ObjectiveEvaluationPanel';
import { SegmentTraceTheater } from '@/components/settings/SegmentTraceTheater';

const WINDOW = {
  start: Date.UTC(2026, 6, 27, 12),
  end: Date.UTC(2026, 7, 3, 12),
};

const evaluation: SegmentEvaluationResponse = {
  segmentId: 'S13',
  window: WINDOW,
  objectives: [
    {
      objectiveId: 'tool-access-correct-use',
      objectiveLabel: '工具可达与正确使用',
      evaluationModelId: 'em-tool-access-correct-use',
      evaluationModelLabel: '工具可达与正确使用评估',
      ruleVersion: 'v1',
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          label: '工具名或 Schema 校验失败次数',
          kind: 'counter',
          evaluatorKind: 'code',
          trigger: { kind: 'distinct-counterexamples', threshold: 3 },
          collection: {
            window: WINDOW,
            positive: 0,
            counterexamples: 3,
            candidates: 0,
            classifiedTotal: 3,
            pendingTowardTrigger: 3,
            required: 3,
          },
          latestEvaluation: {
            result: {
              resultId: 'result-s13-schema-failure',
              snapshotId: 'snapshot-s13-schema-failure',
              ownerUserId: 'showcase',
              objectiveId: 'tool-access-correct-use',
              metricId: 'tool-schema-failure-count',
              kind: 'counter',
              value: { kind: 'counter', count: 3, threshold: 3 },
              evaluatedAt: WINDOW.end,
            },
            window: WINDOW,
          },
        },
        {
          metricId: 'tool-discovery-success-rate',
          label: '明示工具检索后的成功调用率',
          kind: 'rate',
          evaluatorKind: 'code',
          trigger: { kind: 'minimum-sample', minimum: 10, windowMs: 604_800_000 },
          collection: {
            window: WINDOW,
            positive: 8,
            counterexamples: 2,
            candidates: 0,
            classifiedTotal: 10,
            pendingTowardTrigger: 10,
            required: 10,
          },
          latestEvaluation: {
            result: {
              resultId: 'result-s13-discovery',
              snapshotId: 'snapshot-s13-discovery',
              ownerUserId: 'showcase',
              objectiveId: 'tool-access-correct-use',
              metricId: 'tool-discovery-success-rate',
              kind: 'rate',
              value: { kind: 'rate', numerator: 8, denominator: 10, rate: 0.8 },
              evaluatedAt: WINDOW.end,
            },
            window: WINDOW,
          },
        },
        {
          metricId: 'tool-choice-correctness',
          label: '语义场景下工具选择与参数正确性',
          kind: 'semantic',
          evaluatorKind: 'llm',
          trigger: { kind: 'cadence', cadence: 'weekly' },
          collection: {
            window: WINDOW,
            positive: 2,
            counterexamples: 1,
            candidates: 5,
            classifiedTotal: 3,
            pendingTowardTrigger: 0,
            required: null,
          },
          latestEvaluation: null,
        },
      ],
    },
  ],
};

const observations = [
  {
    threadId: 'thread_s13_showcase',
    turnId: 'turn_schema_failure',
    timestamp: Date.UTC(2026, 7, 3, 10, 42),
    catId: 'cat-reviewer',
    pipelineStatus: 'fired',
    version: 1,
    charCount: 1739,
  },
  {
    threadId: 'thread_s13_showcase',
    turnId: 'turn_discovery_success',
    timestamp: Date.UTC(2026, 7, 3, 9, 18),
    catId: 'cat-architect',
    pipelineStatus: 'fired',
    version: 1,
    charCount: 1264,
  },
];

export default function F257ObjectiveEvalShowcase() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <p className="text-sm font-medium text-cafe-muted">S13 · MCP 工具文档</p>
        <h1 className="mt-1 text-2xl font-semibold text-cafe">Objective 指标与 Tracing 回放验收</h1>
        <p className="mt-2 text-sm text-cafe-secondary">
          Tracing 始终采集 TraceEpisode；Objective 决定评估规则。次数阈值、比率与后台语义评估分别展示，
          不为反例次数伪造分母。
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-cafe">评估指标</h2>
        <ObjectiveEvaluationPanel data={evaluation} />
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-cafe">Tracing 回放</h2>
        <SegmentTraceTheater segmentId="S13" observations={observations} />
      </section>
    </main>
  );
}
