import type { CycleRecord, CycleWindow } from '@cat-cafe/shared';
import type { HookOverrideStore } from '../../../domains/prompt-hooks/HookOverrideStore.js';
import { cycleTriggerPolicyFor } from './cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export type ManualVersionCycleErrorCode =
  | 'segment_not_found'
  | 'cycle_not_initialized'
  | 'evaluation_in_progress'
  | 'version_already_active'
  | 'version_cycle_mismatch'
  | 'concurrent_transition'
  | 'compensation_failed';

export class ManualVersionCycleError extends Error {
  constructor(public readonly code: ManualVersionCycleErrorCode) {
    super(`manual_version_switch_${code}`);
    this.name = 'ManualVersionCycleError';
  }
}

interface ManualVersionCycleInput {
  ownerUserId: string;
  segmentId: string;
  targetVersion: number;
  actorId: string;
  reason: string;
}

interface ManualVersionCreateInput extends Omit<ManualVersionCycleInput, 'targetVersion'> {
  content: string;
}

interface ManualVersionCycleResult {
  objectiveId: string;
  fromVersion: number;
  toVersion: number;
  archivedCycleId: string;
  currentCycle: CycleRecord;
}

/**
 * One operator content-version transition across the two F257 axes: mutate the
 * active segment content, archive the live tracing cycle, and start the
 * replacement Objective cycle. The cycle store owns the durable CAS; the
 * in-process Objective lock is shared with CycleTriggerChecker so an eval
 * request cannot race this action.
 */
export class ManualVersionCycleService {
  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      overrideStore: Pick<HookOverrideStore, 'activateVersion' | 'getActiveVersion' | 'setContentOverride'>;
      refreshOverrideSnapshot: () => Promise<void>;
      now?: () => number;
    },
  ) {}

  async switch(input: ManualVersionCycleInput): Promise<ManualVersionCycleResult> {
    const objectiveId = this.objectiveIdFor(input.segmentId);
    await this.deps.runtime.cycleChecker.ensureObjectiveCurrent(input.ownerUserId, objectiveId, this.readNow());

    return this.deps.runtime.cycleChecker.withObjectiveLock(input.ownerUserId, objectiveId, () =>
      this.switchLocked(input, objectiveId),
    );
  }

  async create(input: ManualVersionCreateInput): Promise<ManualVersionCycleResult> {
    const objectiveId = this.objectiveIdFor(input.segmentId);
    await this.deps.runtime.cycleChecker.ensureObjectiveCurrent(input.ownerUserId, objectiveId, this.readNow());
    return this.deps.runtime.cycleChecker.withObjectiveLock(input.ownerUserId, objectiveId, () =>
      this.createLocked(input, objectiveId),
    );
  }

  private async switchLocked(input: ManualVersionCycleInput, objectiveId: string): Promise<ManualVersionCycleResult> {
    const { current, sourceVersion, switchedAt } = await this.prepare(input, objectiveId);
    if (sourceVersion === input.targetVersion) throw new ManualVersionCycleError('version_already_active');
    return this.mutateAndTransition(input, objectiveId, current, sourceVersion, switchedAt, async () => {
      await this.deps.overrideStore.activateVersion(input.segmentId, input.targetVersion, input.actorId, {
        source: 'operator',
        reason: input.reason,
      });
      return input.targetVersion;
    });
  }

  private async createLocked(input: ManualVersionCreateInput, objectiveId: string): Promise<ManualVersionCycleResult> {
    const { current, sourceVersion, switchedAt } = await this.prepare(input, objectiveId);
    return this.mutateAndTransition(input, objectiveId, current, sourceVersion, switchedAt, async () => {
      await this.deps.overrideStore.setContentOverride(input.segmentId, input.content, input.actorId, {
        source: 'operator',
        reason: input.reason,
      });
      return this.deps.overrideStore.getActiveVersion(input.segmentId);
    });
  }

  private async prepare(
    input: Pick<ManualVersionCycleInput, 'ownerUserId' | 'segmentId'>,
    objectiveId: string,
  ): Promise<{ current: CycleRecord; sourceVersion: number; switchedAt: number }> {
    const current = await this.deps.runtime.cycles.current(input.ownerUserId, objectiveId);
    if (!current) throw new ManualVersionCycleError('cycle_not_initialized');
    if (current.evalStatus !== 'idle') throw new ManualVersionCycleError('evaluation_in_progress');
    const [sourceVersion, cycleSegmentVersion] = await Promise.all([
      this.deps.overrideStore.getActiveVersion(input.segmentId),
      this.deps.runtime.resolveSegmentVersion(current.versionContentRef, input.segmentId),
    ]);
    if (cycleSegmentVersion !== sourceVersion) throw new ManualVersionCycleError('version_cycle_mismatch');
    const switchedAt = this.readNow();
    if (!Number.isFinite(switchedAt) || switchedAt < current.cycleStart) {
      throw new ManualVersionCycleError('concurrent_transition');
    }
    return { current, sourceVersion, switchedAt };
  }

  private async mutateAndTransition(
    input: Omit<ManualVersionCycleInput, 'targetVersion'>,
    objectiveId: string,
    current: CycleRecord,
    sourceVersion: number,
    switchedAt: number,
    mutate: () => Promise<number>,
  ): Promise<ManualVersionCycleResult> {
    let mutationCompleted = false;
    try {
      const targetVersion = await mutate();
      mutationCompleted = true;
      await this.deps.refreshOverrideSnapshot();

      const nextVersion = await this.deps.runtime.resolveVersion(objectiveId, {
        triggerPolicy: cycleTriggerPolicyFor(this.deps.runtime.catalog, current),
        lifecycle: current.objectiveLifecycle ?? 'active',
      });
      const resolvedTarget = await this.deps.runtime.resolveSegmentVersion(
        nextVersion.versionContentRef,
        input.segmentId,
      );
      if (resolvedTarget !== targetVersion) throw new ManualVersionCycleError('version_cycle_mismatch');
      const completed = completedCycle(current, input, sourceVersion, targetVersion, switchedAt);
      const carryoverWindows = inheritedWindows(current, input.segmentId, sourceVersion, switchedAt);
      const next = await this.deps.runtime.cycles.switchVersion(current, completed, nextVersion, carryoverWindows);
      if (!next) throw new ManualVersionCycleError('concurrent_transition');
      return {
        objectiveId,
        fromVersion: sourceVersion,
        toVersion: targetVersion,
        archivedCycleId: current.cycleId,
        currentCycle: next,
      };
    } catch (error) {
      if (mutationCompleted) {
        try {
          await this.deps.overrideStore.activateVersion(input.segmentId, sourceVersion, input.actorId, {
            source: 'operator',
            reason: `补偿失败的版本切换：${input.reason}`,
          });
          await this.deps.refreshOverrideSnapshot();
        } catch {
          throw new ManualVersionCycleError('compensation_failed');
        }
      }
      throw error;
    }
  }

  private objectiveIdFor(segmentId: string): string {
    const unit = this.deps.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === segmentId);
    const objectiveId = unit?.objectives[0]?.objectiveId;
    if (!unit || !objectiveId) throw new ManualVersionCycleError('segment_not_found');
    return objectiveId;
  }

  private readNow(): number {
    const now = (this.deps.now ?? Date.now)();
    if (!Number.isFinite(now) || now < 0) throw new ManualVersionCycleError('concurrent_transition');
    return now;
  }
}

function completedCycle(
  current: CycleRecord,
  input: Omit<ManualVersionCycleInput, 'targetVersion'>,
  sourceVersion: number,
  targetVersion: number,
  switchedAt: number,
): CycleRecord {
  return {
    ...current,
    cycleEnd: switchedAt,
    termination: {
      kind: 'manual-version-switch',
      segmentId: input.segmentId,
      fromVersion: sourceVersion,
      toVersion: targetVersion,
      at: switchedAt,
      by: input.actorId,
      reason: input.reason,
    },
    closedAt: switchedAt,
  };
}

function inheritedWindows(
  current: CycleRecord,
  segmentId: string,
  sourceSegmentVersion: number,
  switchedAt: number,
): CycleWindow[] {
  const inherited = [...(current.carryoverWindows ?? [])];
  if (switchedAt > current.cycleStart) {
    inherited.push({
      start: current.cycleStart,
      end: switchedAt,
      provenance: {
        kind: 'manual-version-switch',
        sourceCycleId: current.cycleId,
        sourceVersion: current.version,
        sourceVersionContentRef: current.versionContentRef,
        sourceSegmentId: segmentId,
        sourceSegmentVersion,
      },
    });
  }
  return inherited;
}
