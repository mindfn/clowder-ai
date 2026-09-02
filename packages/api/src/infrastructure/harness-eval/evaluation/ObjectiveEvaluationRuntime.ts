import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { CycleRecordStore } from './CycleRecordStore.js';
import { CycleTriggerChecker, type CycleVersionRef } from './CycleTriggerChecker.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';
import { ObjectiveTraceIndex } from './ObjectiveTraceIndex.js';

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly results: MetricResultStore;
  readonly judgments: ObjectiveJudgmentStore;
  readonly cycles: CycleRecordStore;
  readonly cycleChecker: CycleTriggerChecker;
  readonly objectiveTraces: ObjectiveTraceIndex;
  readonly traces: InjectionTraceStore;

  constructor(
    redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: {
      traceStore?: InjectionTraceStore;
      resolveVersion?: (objectiveId: string) => CycleVersionRef | Promise<CycleVersionRef>;
    } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.results = new MetricResultStore(redis);
    this.judgments = new ObjectiveJudgmentStore(redis);
    this.traces = options.traceStore ?? new InjectionTraceStore(redis);
    this.cycles = new CycleRecordStore(redis);
    this.objectiveTraces = new ObjectiveTraceIndex(redis, catalog, this.traces);
    this.cycleChecker = new CycleTriggerChecker({
      catalog,
      cycles: this.cycles,
      traces: this.traces,
      objectiveTraces: this.objectiveTraces,
      annotations,
      resolveVersion:
        options.resolveVersion ??
        ((objectiveId) => {
          const objective = catalog.registry.objectives.find((item) => item.id === objectiveId);
          const model = catalog.registry.evaluationModels.find((item) => item.id === objective?.evaluationModelId);
          if (!model) throw new Error(`cycle_evaluation_model_not_found:${objectiveId}`);
          return {
            version: model.ruleVersion,
            versionContentRef: `evaluation-model:${model.id}@${model.ruleVersion}`,
          };
        }),
    });
  }

  async append(annotation: TraceAnnotation): Promise<{
    outcome: 'created' | 'duplicate';
    annotationId: string;
    cycleEvaluationReady?: boolean;
  }> {
    const appended = await this.indexer.append(annotation);
    const checked = await this.cycleChecker.checkObjective(
      annotation.episodeRef.ownerUserId,
      annotation.objectiveId,
      annotation.createdAt + 1,
    );
    return { ...appended, ...(checked.status === 'requested' ? { cycleEvaluationReady: true } : {}) };
  }

  async initializeCycles(ownerUserId: string, now: number): Promise<void> {
    await this.cycleChecker.initializeOwner(ownerUserId, now);
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    return this.cycleChecker.checkOwner(ownerUserId, now);
  }

  async checkCyclesAfterTrace(ownerUserId: string, invocationId: string, now: number): Promise<number> {
    return this.cycleChecker.checkTrace(ownerUserId, invocationId, now);
  }

  async checkKnownCycleOwners(now: number): Promise<number> {
    return this.cycleChecker.checkKnownOwners(now);
  }
}
