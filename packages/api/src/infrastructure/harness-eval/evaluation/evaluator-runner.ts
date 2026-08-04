import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricDefinition, MetricResult } from '@cat-cafe/shared';
import { evaluateCounterSnapshot, evaluateRateSnapshot } from './EvaluationScheduler.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ReplayEvaluator {
  evaluate(snapshot: EvaluationSnapshot, metric: MetricDefinition): Promise<{ passed: number; failed: number }>;
}

/**
 * Dispatches immutable snapshots by evaluator kind. LLM rule execution happens
 * upstream in the semantic sweep; this runner deterministically aggregates the
 * frozen LLM-classified samples into a MetricResult. Replay stays behind an
 * explicit adapter and is never guessed when the adapter is absent.
 */
export class EvaluatorRunner {
  constructor(private readonly deps: { replay?: ReplayEvaluator } = {}) {}

  canRun(metric: MetricDefinition): boolean {
    return metric.evaluator.kind !== 'replay' || this.deps.replay !== undefined;
  }

  async run(snapshot: EvaluationSnapshot, metric: MetricDefinition, evaluatedAt: number): Promise<MetricResult> {
    if (snapshot.metricId !== metric.id) throw new Error(`evaluator_metric_mismatch:${snapshot.metricId}`);
    if (metric.evaluator.kind === 'code') {
      if (metric.kind === 'counter') return evaluateCounterSnapshot(snapshot, metric, evaluatedAt);
      if (metric.kind === 'rate') return evaluateRateSnapshot(snapshot, metric, evaluatedAt);
      throw new Error(`code_evaluator_metric_not_supported:${metric.id}`);
    }
    if (metric.evaluator.kind === 'llm') {
      if (metric.kind !== 'semantic') throw new Error(`llm_evaluator_metric_not_supported:${metric.id}`);
      const semanticSamples = snapshot.samples.filter((sample) => sample.source === 'semantic-sweep');
      if (semanticSamples.length === 0)
        throw new Error(`llm_evaluator_missing_semantic_samples:${snapshot.snapshotId}`);
      const labels: Record<string, number> = {};
      for (const sample of semanticSamples) labels[sample.polarity] = (labels[sample.polarity] ?? 0) + 1;
      return {
        resultId: `result-${digest(['semantic', snapshot.snapshotId, snapshot.ruleVersion])}`,
        snapshotId: snapshot.snapshotId,
        ownerUserId: snapshot.ownerUserId,
        objectiveId: snapshot.objectiveId,
        metricId: snapshot.metricId,
        kind: 'semantic',
        value: {
          kind: 'semantic',
          labels,
          explanation: `${semanticSamples.length} LLM-classified episodes evaluated by ${metric.evaluator.ruleRef}.`,
        },
        evaluatedAt,
      };
    }
    if (!this.deps.replay) throw new Error(`replay_evaluator_unavailable:${metric.id}`);
    if (metric.kind !== 'replay') throw new Error(`replay_evaluator_metric_not_supported:${metric.id}`);
    const value = await this.deps.replay.evaluate(snapshot, metric);
    return {
      resultId: `result-${digest(['replay', snapshot.snapshotId, snapshot.ruleVersion, value])}`,
      snapshotId: snapshot.snapshotId,
      ownerUserId: snapshot.ownerUserId,
      objectiveId: snapshot.objectiveId,
      metricId: snapshot.metricId,
      kind: 'replay',
      value: { kind: 'replay', ...value },
      evaluatedAt,
    };
  }
}
