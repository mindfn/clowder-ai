import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricDefinition, MetricResult } from '@cat-cafe/shared';
import { evaluateCounterSnapshot, evaluateRateSnapshot } from './EvaluationScheduler.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ReplayEvaluator {
  evaluate(snapshot: EvaluationSnapshot, metric: MetricDefinition): Promise<{ passed: number; failed: number }>;
}

/**
 * Dispatches immutable Unit snapshots by evaluator kind. LLM rule execution happens
 * upstream in the semantic sweep; this runner deterministically aggregates the
 * frozen LLM-classified samples into a MetricResult. Replay stays behind an
 * explicit adapter and is never guessed when the adapter is absent.
 */
export class EvaluatorRunner {
  constructor(private readonly deps: { replay?: ReplayEvaluator } = {}) {}

  canRun(metric: MetricDefinition): boolean {
    return metric.evaluator.kind !== 'replay' || this.deps.replay !== undefined;
  }

  async run(snapshot: EvaluationSnapshot, metric: MetricDefinition, evaluatedAt: number): Promise<MetricResult | null> {
    if (!snapshot.metricDefinitions.some((definition) => definition.id === metric.id)) {
      throw new Error(`evaluator_metric_not_in_snapshot:${metric.id}:${snapshot.snapshotId}`);
    }
    switch (metric.evaluator.kind) {
      case 'code':
        return this.runCodeEvaluator(snapshot, metric, evaluatedAt);
      case 'llm':
        return this.runLlmEvaluator(snapshot, metric, evaluatedAt);
      case 'replay':
        return this.runReplayEvaluator(snapshot, metric, evaluatedAt);
      default:
        throw new Error(`evaluator_kind_not_supported:${metric.id}`);
    }
  }

  private runCodeEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): MetricResult | null {
    if (metric.kind === 'counter') return evaluateCounterSnapshot(snapshot, metric, evaluatedAt);
    if (metric.kind === 'rate') return evaluateRateSnapshot(snapshot, metric, evaluatedAt);
    throw new Error(`code_evaluator_metric_not_supported:${metric.id}`);
  }

  private runLlmEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): MetricResult | null {
    if (metric.kind !== 'semantic') throw new Error(`llm_evaluator_metric_not_supported:${metric.id}`);
    const semanticSamples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
    if (semanticSamples.length === 0) return null;
    const labels: Record<string, number> = {};
    for (const sample of semanticSamples) labels[sample.polarity] = (labels[sample.polarity] ?? 0) + 1;
    return {
      resultId: `result-${digest(['semantic', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`,
      snapshotId: snapshot.snapshotId,
      ownerUserId: snapshot.ownerUserId,
      objectiveId: snapshot.objectiveId,
      metricId: metric.id,
      kind: 'semantic',
      value: {
        kind: 'semantic',
        labels,
        explanation: `${semanticSamples.length} LLM-classified episodes evaluated by ${metric.evaluator.ruleRef}.`,
      },
      evaluatedAt,
    };
  }

  private async runReplayEvaluator(
    snapshot: EvaluationSnapshot,
    metric: MetricDefinition,
    evaluatedAt: number,
  ): Promise<MetricResult> {
    if (!this.deps.replay) throw new Error(`replay_evaluator_unavailable:${metric.id}`);
    if (metric.kind !== 'replay') throw new Error(`replay_evaluator_metric_not_supported:${metric.id}`);
    const value = await this.deps.replay.evaluate(snapshot, metric);
    return {
      resultId: `result-${digest(['replay', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id, value])}`,
      snapshotId: snapshot.snapshotId,
      ownerUserId: snapshot.ownerUserId,
      objectiveId: snapshot.objectiveId,
      metricId: metric.id,
      kind: 'replay',
      value: { kind: 'replay', ...value },
      evaluatedAt,
    };
  }
}
