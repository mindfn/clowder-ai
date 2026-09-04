import type { CycleRecord, CycleTriggerRoute, CycleWindow, TraceAnnotation } from '@cat-cafe/shared';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { CycleRecordStore, isSkippedCycle } from './CycleRecordStore.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';
import type { ObjectiveTraceIndex } from './ObjectiveTraceIndex.js';

export type CycleCheckResult =
  | { status: 'idle' | 'interval' | 'active'; record: CycleRecord }
  | { status: 'requested'; record: CycleRecord };

export interface CycleVersionRef {
  version: string;
  versionContentRef: string;
}

export class CycleTriggerChecker {
  private requestedHandler?: (record: CycleRecord) => void;

  constructor(
    private readonly deps: {
      catalog: EvaluationCatalog;
      cycles: CycleRecordStore;
      traces: Pick<InjectionTraceStore, 'getEpisodeByInvocationId'>;
      objectiveTraces: Pick<ObjectiveTraceIndex, 'countWindow' | 'earliest' | 'ensureOwnerBackfilled' | 'indexEpisode'>;
      annotations: Pick<TraceAnnotationStore, 'queryMetricWindow'>;
      resolveVersion: (objectiveId: string) => CycleVersionRef | Promise<CycleVersionRef>;
    },
  ) {}

  setRequestedHandler(handler: (record: CycleRecord) => void): void {
    this.requestedHandler = handler;
  }

  async initializeOwner(ownerUserId: string, now: number): Promise<void> {
    await this.deps.objectiveTraces.ensureOwnerBackfilled(ownerUserId, now);
    for (const objective of this.deps.catalog.registry.objectives) {
      await this.ensureCurrent(ownerUserId, objective.id, now);
    }
  }

  async checkOwner(ownerUserId: string, now: number): Promise<number> {
    let requested = 0;
    for (const objective of this.deps.catalog.registry.objectives) {
      const result = await this.checkObjective(ownerUserId, objective.id, now);
      if (result.status === 'requested') requested++;
    }
    return requested;
  }

  async checkKnownOwners(now: number): Promise<number> {
    let requested = 0;
    for (const ownerUserId of await this.deps.cycles.ownerUserIds()) {
      requested += await this.checkOwner(ownerUserId, now);
    }
    return requested;
  }

  async checkTrace(ownerUserId: string, invocationId: string, now: number): Promise<number> {
    const episode = await this.deps.traces.getEpisodeByInvocationId(invocationId);
    if (!episode || episode.terminal.ownerUserId !== ownerUserId) return 0;
    const objectiveIds = await this.deps.objectiveTraces.indexEpisode(episode);
    let requested = 0;
    for (const objectiveId of objectiveIds) {
      if ((await this.checkObjective(ownerUserId, objectiveId, now)).status === 'requested') requested++;
    }
    return requested;
  }

  async checkObjective(ownerUserId: string, objectiveId: string, now: number): Promise<CycleCheckResult> {
    const objective = this.deps.catalog.registry.objectives.find((item) => item.id === objectiveId);
    if (!objective) throw new Error(`cycle_objective_not_found:${objectiveId}`);
    const model = this.deps.catalog.registry.evaluationModels.find((item) => item.id === objective.evaluationModelId);
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${objective.evaluationModelId}`);

    const current = await this.ensureCurrent(ownerUserId, objectiveId, now);
    if (current.evalStatus !== 'idle') return { status: 'active', record: current };

    const history = await this.deps.cycles.history(ownerUserId, objectiveId);
    const lastClosedAt = history[0]?.closedAt;
    if (lastClosedAt !== undefined && now < lastClosedAt + model.cycleTrigger.minimumIntervalMs) {
      return { status: 'interval', record: current };
    }

    const observedInvocationCount = await this.deps.objectiveTraces.countWindow(
      ownerUserId,
      objectiveId,
      current.cycleStart,
      now,
    );
    const counterexamples = await this.distinctCounterexamples(
      ownerUserId,
      objectiveId,
      model.metrics.map((metric) => metric.id),
      current.cycleStart,
      now,
    );
    const triggeredBy: CycleTriggerRoute[] = [];
    if (observedInvocationCount >= model.cycleTrigger.cumulativeThreshold) triggeredBy.push('cumulative');
    if (counterexamples.size >= model.cycleTrigger.counterexampleThreshold) triggeredBy.push('counterexamples');
    if (
      observedInvocationCount > 0 &&
      now - current.cycleStart >= model.cycleTrigger.cadenceDays * 24 * 60 * 60 * 1000
    ) {
      triggeredBy.push('cadence');
    }
    if (triggeredBy.length === 0) return { status: 'idle', record: current };

    const window = { start: current.cycleStart, end: now };
    const requested: CycleRecord = {
      ...current,
      cycleEnd: now,
      evalStatus: 'requested',
      windows: [...priorSkipWindows(history), window],
      triggeredBy,
    };
    if (await this.deps.cycles.request(current, requested)) {
      this.requestedHandler?.(requested);
      return { status: 'requested', record: requested };
    }
    const winner = await this.deps.cycles.current(ownerUserId, objectiveId);
    if (!winner) throw new Error(`cycle_cas_winner_missing:${ownerUserId}:${objectiveId}`);
    return { status: 'active', record: winner };
  }

  private async ensureCurrent(ownerUserId: string, objectiveId: string, now: number): Promise<CycleRecord> {
    const existing = await this.deps.cycles.current(ownerUserId, objectiveId);
    if (existing) return existing;
    const legacyStart = await this.deps.cycles.legacyCompletedWindowEnd(ownerUserId, objectiveId);
    if (legacyStart !== null && legacyStart > now) throw new Error(`cycle_start_after_now:${objectiveId}`);
    const cycleStart = legacyStart ?? (await this.deps.objectiveTraces.earliest(ownerUserId, objectiveId, now)) ?? now;
    const version = await this.deps.resolveVersion(objectiveId);
    return this.deps.cycles.initialize(ownerUserId, objectiveId, cycleStart, version);
  }

  private async distinctCounterexamples(
    ownerUserId: string,
    objectiveId: string,
    metricIds: string[],
    start: number,
    end: number,
  ): Promise<Set<string>> {
    const lists = await Promise.all(
      metricIds.map((metricId) =>
        this.deps.annotations.queryMetricWindow(ownerUserId, objectiveId, metricId, start, end),
      ),
    );
    return new Set(
      lists
        .flat()
        .filter((annotation: TraceAnnotation) => annotation.polarity === 'counterexample')
        .map((annotation) => annotation.incidentKey),
    );
  }
}

function priorSkipWindows(history: CycleRecord[]): CycleWindow[] {
  const windows: CycleWindow[] = [];
  for (const record of history) {
    if (!isSkippedCycle(record)) break;
    if (record.cycleEnd === undefined) throw new Error(`skipped_cycle_end_missing:${record.cycleId}`);
    windows.push({ start: record.cycleStart, end: record.cycleEnd });
  }
  return windows.reverse();
}
