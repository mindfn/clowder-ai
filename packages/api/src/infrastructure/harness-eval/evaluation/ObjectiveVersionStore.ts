import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CycleTriggerPolicy, HookManifest, ObjectiveLifecycle } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HookRegistry } from '../../../domains/prompt-hooks/HookRegistry.js';
import type { CycleVersionRef } from './CycleTriggerChecker.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

export interface ObjectiveVersionState {
  triggerPolicy: CycleTriggerPolicy;
  lifecycle: Exclude<ObjectiveLifecycle, 'retired'>;
}

interface ObjectiveVersionSnapshot {
  schemaVersion: 1;
  objective: { id: string; label: string; statement: string; lifecycle: ObjectiveLifecycle };
  evaluationModel: unknown;
  effectiveTriggerPolicy: CycleTriggerPolicy;
  effectiveLifecycle: Exclude<ObjectiveLifecycle, 'retired'>;
  units: Array<{
    unitId: string;
    manifest: HookManifest;
    enabled: boolean;
    activeContentVersion: number;
    contentHash: string;
    conditionOverride: unknown | null;
  }>;
}

const snapshotKey = (objectiveId: string, digest: string) => `harness-objective-version:${objectiveId}:${digest}`;

/** Content-addressed, immutable Objective versions; no hook-version record is reused as an Objective identity. */
export class ObjectiveVersionStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly catalog: EvaluationCatalog,
    private readonly getRegistry: () => HookRegistry | null,
  ) {}

  async resolve(objectiveId: string, state: ObjectiveVersionState): Promise<CycleVersionRef> {
    const snapshot = await this.capture(objectiveId, state);
    const serialized = stableStringify(snapshot);
    const digest = createHash('sha256').update(serialized).digest('hex');
    await this.redis.set(snapshotKey(objectiveId, digest), serialized, 'NX');
    return {
      version: `objective-${digest.slice(0, 16)}`,
      versionContentRef: snapshotKey(objectiveId, digest),
    };
  }

  private async capture(objectiveId: string, state: ObjectiveVersionState): Promise<ObjectiveVersionSnapshot> {
    const objective = this.catalog.registry.objectives.find((candidate) => candidate.id === objectiveId);
    const evaluationModel = this.catalog.registry.evaluationModels.find(
      (candidate) => candidate.id === objective?.evaluationModelId,
    );
    if (!objective || !evaluationModel) throw new Error(`cycle_evaluation_model_not_found:${objectiveId}`);
    const registry = this.getRegistry();
    if (!registry) throw new Error('hook_registry_not_initialized');
    const units = await Promise.all(
      this.catalog.manifest.units
        .filter((unit) => unit.objectives.some((attachment) => attachment.objectiveId === objectiveId))
        .map(async (unit) => {
          const hook = registry.getHook(unit.unitId);
          if (!hook) throw new Error(`harness_governance_hook_missing:${unit.unitId}`);
          const content = registry.getContentOverride(unit.unitId) ?? (await readFile(hook.templatePath, 'utf8'));
          return {
            unitId: unit.unitId,
            manifest: structuredClone(hook.manifest),
            enabled: registry.isEnabled(unit.unitId),
            activeContentVersion: registry.getActiveVersion(unit.unitId),
            contentHash: createHash('sha256').update(content).digest('hex'),
            conditionOverride: registry.getConditionOverride(unit.unitId) ?? null,
          };
        }),
    );
    units.sort((left, right) => left.unitId.localeCompare(right.unitId));
    return {
      schemaVersion: 1,
      objective: {
        id: objective.id,
        label: objective.label,
        statement: objective.statement,
        lifecycle: objective.lifecycle ?? 'active',
      },
      evaluationModel: structuredClone(evaluationModel),
      effectiveTriggerPolicy: structuredClone(state.triggerPolicy),
      effectiveLifecycle: state.lifecycle,
      units,
    };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
