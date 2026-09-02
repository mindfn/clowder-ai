import { createHash } from 'node:crypto';
import type { JudgmentCommittedEvent, ObjectiveJudgment, SegmentVerdict, TraceAnnotation } from '@cat-cafe/shared';
import { SEGMENT_VERDICTS } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { CycleRecordStore } from './CycleRecordStore.js';
import { CycleTriggerChecker, type CycleVersionRef } from './CycleTriggerChecker.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';
import {
  isCurrentVerdictDecision,
  produceObjectiveVerdictDecision,
  verdictForMetricDecisions,
} from './objective-verdict.js';

export { produceObjectiveVerdictDecision } from './objective-verdict.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * F257 conclusion→governance seam: post-commit hook fired after every SUCCESSFUL
 * Unit-run commit. Modeled on GuardRejectionEventLog.setPostAppendHook.
 * Implementations must be fail-open (the emit site awaits it inside try/catch).
 */
export type JudgmentCommittedHook = (event: JudgmentCommittedEvent) => void | Promise<void>;

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly judgments: ObjectiveJudgmentStore;
  readonly cycles: CycleRecordStore;
  readonly cycleChecker: CycleTriggerChecker;
  readonly traces: InjectionTraceStore;
  private postCommitHook?: JudgmentCommittedHook;

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
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.judgments = new ObjectiveJudgmentStore(redis, async (value) => this.normalizeStoredJudgment(value));
    this.traces = options.traceStore ?? new InjectionTraceStore(redis);
    this.cycles = new CycleRecordStore(redis);
    this.cycleChecker = new CycleTriggerChecker({
      catalog,
      cycles: this.cycles,
      traces: this.traces,
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

  /**
   * Register a post-commit hook (F257 conclusion→governance→candidate). Fired
   * after every SUCCESSFUL Unit-run commit with a JudgmentCommittedEvent built
   * from the committed ObjectiveJudgment. Modeled EXACTLY on
   * GuardRejectionEventLog.setPostAppendHook: the emit site awaits the hook (so
   * the append chain resolves after the worker runs) but swallows throws
   * (fail-open) so a governance-worker failure never breaks the eval commit.
   */
  setPostCommitHook(hook: JudgmentCommittedHook): void {
    this.postCommitHook = hook;
  }

  /**
   * Cold-start repair for pre-v2 durable judgments. Reading normalizes the
   * stored row from its immutable snapshot, then re-emits it through the
   * idempotent governance worker. No operator re-trigger is required.
   */
  async reconcileLatestJudgments(ownerUserId: string): Promise<void> {
    for (const objective of this.catalog.registry.objectives) {
      const judgment = await this.judgments.latest(ownerUserId, objective.id);
      if (judgment) await this.emitJudgmentCommitted(judgment);
    }
  }

  private async normalizeStoredJudgment(value: unknown): Promise<ObjectiveJudgment | null> {
    if (!isRecord(value)) return null;
    const core = value as Partial<ObjectiveJudgment>;
    if (
      typeof core.judgmentId !== 'string' ||
      typeof core.snapshotId !== 'string' ||
      typeof core.ownerUserId !== 'string' ||
      typeof core.objectiveId !== 'string' ||
      !Array.isArray(core.metricResults) ||
      !Array.isArray(core.metricOutcomes) ||
      !Array.isArray(core.unitRefs) ||
      typeof core.evaluatedAt !== 'number'
    ) {
      return null;
    }
    if (
      core.schemaVersion === 2 &&
      typeof core.verdict === 'string' &&
      SEGMENT_VERDICTS.includes(core.verdict as SegmentVerdict) &&
      isCurrentVerdictDecision(core.verdictDecision) &&
      core.verdict === verdictForMetricDecisions(core.verdictDecision.metricDecisions) &&
      core.evaluationModelVersion === core.verdictDecision.evaluationModelVersion
    ) {
      return core as ObjectiveJudgment;
    }

    const snapshot = await this.snapshots.get(core.snapshotId);
    if (
      !snapshot ||
      snapshot.ownerUserId !== core.ownerUserId ||
      snapshot.objectiveId !== core.objectiveId ||
      snapshot.evaluationModelId !== core.evaluationModelId ||
      snapshot.evaluationModelVersion !== core.evaluationModelVersion
    ) {
      return null;
    }
    // The snapshot is the immutable evaluation contract. Never rebuild an old
    // judgment from the live registry: a later model/rule revision must not
    // rejudge historical evidence or mint a Candidate under rules that never
    // evaluated that evidence.
    const conclusion = produceObjectiveVerdictDecision(snapshot, core.metricResults, core.metricOutcomes);
    return {
      ...(value as Omit<ObjectiveJudgment, 'schemaVersion' | 'verdict' | 'verdictDecision'>),
      schemaVersion: 2,
      evaluationModelVersion: snapshot.evaluationModelVersion,
      verdict: conclusion.verdict,
      verdictDecision: conclusion.decision,
    };
  }

  private async emitJudgmentCommitted(judgment: ObjectiveJudgment): Promise<void> {
    if (!this.postCommitHook) return;
    const snapshot = await this.snapshots.get(judgment.snapshotId);
    const episodes = await this.traces.queryUnitWindow(
      judgment.ownerUserId,
      judgment.unitRefs,
      judgment.window.start,
      judgment.window.end,
    );
    const segmentTraceHashes: Record<string, string> = {};
    for (const segmentId of new Set(judgment.unitRefs.map((ref) => ref.unitId))) {
      const states = episodes.flatMap((episode) =>
        episode.summary.segments
          .filter((segment) => segment.segmentId === segmentId)
          .map((segment) => ({
            status: segment.status,
            pipelineStatus: segment.pipelineStatus ?? null,
            contentHash: segment.contentHash,
            version: segment.version ?? null,
          })),
      );
      if (states.length > 0) {
        const canonicalStates = [...new Set(states.map((state) => JSON.stringify(state)))].sort();
        segmentTraceHashes[segmentId] = `sha256:${digest(canonicalStates)}`;
      }
    }
    const event: JudgmentCommittedEvent = {
      judgmentId: judgment.judgmentId,
      ownerUserId: judgment.ownerUserId,
      objectiveId: judgment.objectiveId,
      verdict: judgment.verdict,
      verdictDecision: judgment.verdictDecision,
      unitRefs: judgment.unitRefs,
      counterexampleAnchors:
        snapshot?.samples
          .filter((sample) => sample.polarity === 'counterexample')
          .map((sample) => sample.annotationId) ?? [],
      segmentTraceHashes,
      window: judgment.window,
      evaluatedAt: judgment.evaluatedAt,
    };
    try {
      await this.postCommitHook(event);
    } catch {
      /* fail-open: a governance-worker failure must not break the eval commit. */
    }
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
