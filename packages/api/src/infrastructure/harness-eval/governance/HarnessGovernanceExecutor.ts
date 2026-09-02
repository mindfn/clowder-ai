import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  CycleGovernanceSubmission,
  HarnessGovernanceChangeDraft,
  HarnessGovernanceProposal,
  HarnessGovernanceProposalChange,
  HarnessUnitAddDraft,
} from '@cat-cafe/shared';
import type { HookOverrideStore } from '../../../domains/prompt-hooks/HookOverrideStore.js';
import type { HookRegistry } from '../../../domains/prompt-hooks/HookRegistry.js';
import type { CycleVersionRef } from '../evaluation/CycleTriggerChecker.js';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import type { HarnessUnitDirectoryWriter } from './HarnessUnitDirectoryWriter.js';

type AddChange = Extract<HarnessGovernanceProposalChange, { action: 'add' }>;
type EnablementChange = Extract<HarnessGovernanceProposalChange, { action: 'enable' | 'disable' }>;
type ContentChange = Extract<HarnessGovernanceProposalChange, { action: 'modify' | 'rollback' }>;
type RegisteredHook = NonNullable<ReturnType<HookRegistry['getHook']>>;
type OverrideAudit = { source: 'operator'; reason: string };

export class HarnessGovernanceExecutor {
  constructor(
    private readonly deps: {
      catalog: EvaluationCatalog;
      overrideStore: HookOverrideStore;
      getRegistry: () => HookRegistry | null;
      reloadPipeline: () => Promise<void>;
      unitWriter?: HarnessUnitDirectoryWriter;
    },
  ) {}

  async hydrate(objectiveId: string, input: CycleGovernanceSubmission): Promise<HarnessGovernanceProposalChange[]> {
    if (input.decision === 'keep') {
      return this.hydrateKeep(input);
    }
    if (input.decision === 'rollback') return [await this.hydrateRollback(objectiveId, input)];
    return this.hydrateEvolution(objectiveId, input);
  }

  private hydrateKeep(input: CycleGovernanceSubmission): HarnessGovernanceProposalChange[] {
    if (input.rollback || input.v2Draft) throw new Error('cycle_governance_keep_cannot_mutate');
    return [];
  }

  private async hydrateEvolution(
    objectiveId: string,
    input: CycleGovernanceSubmission,
  ): Promise<HarnessGovernanceProposalChange[]> {
    if (input.rollback || !input.v2Draft?.changes.length) {
      throw new Error('cycle_governance_evolve_requires_draft');
    }
    if (input.v2Draft.changes.length > 16) throw new Error('cycle_governance_change_limit');
    const seen = new Set<string>();
    const changes: HarnessGovernanceProposalChange[] = [];
    for (const draft of input.v2Draft.changes) {
      const coordinate = changeCoordinate(draft);
      if (seen.has(coordinate)) throw new Error(`cycle_governance_duplicate_change:${coordinate}`);
      seen.add(coordinate);
      if (draft.reason.trim().length === 0) throw new Error('cycle_governance_change_reason_required');
      changes.push(await this.hydrateDraftChange(objectiveId, draft));
    }
    return changes;
  }

  private async hydrateDraftChange(
    objectiveId: string,
    draft: HarnessGovernanceChangeDraft,
  ): Promise<HarnessGovernanceProposalChange> {
    if (draft.action === 'add') return this.hydrateAdd(objectiveId, draft);
    const state = await this.requireUnit(objectiveId, draft.unitId);
    if (draft.action === 'enable' || draft.action === 'disable') {
      if (draft.action === 'disable' && !state.manifest.disableable) {
        throw new Error(`cycle_governance_disable_forbidden:${draft.unitId}`);
      }
      return {
        action: draft.action,
        unitId: draft.unitId,
        hookId: state.manifest.id,
        reason: draft.reason.trim(),
        beforeEnabled: state.enabled,
      };
    }
    if (state.manifest.safetyTier === 'readonly' || draft.proposedContent.trim().length === 0) {
      throw new Error(`cycle_governance_modify_forbidden:${draft.unitId}`);
    }
    if (draft.proposedContent.trim() === state.content.trim()) {
      throw new Error(`cycle_governance_content_unchanged:${draft.unitId}`);
    }
    return {
      action: 'modify',
      unitId: draft.unitId,
      hookId: state.manifest.id,
      reason: draft.reason.trim(),
      sourceVersion: state.version,
      beforeContent: state.content,
      proposedContent: draft.proposedContent,
    };
  }

  private hydrateAdd(objectiveId: string, draft: Extract<HarnessGovernanceChangeDraft, { action: 'add' }>): AddChange {
    this.validateAdd(objectiveId, draft.unit);
    return {
      action: 'add',
      unitId: draft.unit.unitId,
      hookId: draft.unit.unitId,
      assetSlug: draft.unit.assetSlug,
      reason: draft.reason.trim(),
      manifest: structuredClone(draft.unit.manifest),
      content: draft.unit.content,
      objectives: draft.unit.objectives.map((attachment) => ({ ...attachment })),
    };
  }

  async apply(proposal: HarnessGovernanceProposal, actorId: string, reason: string): Promise<CycleVersionRef> {
    for (const change of proposal.changes) await this.applyChange(change, actorId, reason);
    await this.deps.reloadPipeline();
    return this.currentVersion(proposal.objectiveId);
  }

  async currentVersion(objectiveId: string): Promise<CycleVersionRef> {
    const registry = this.requireRegistry();
    const refs = this.deps.catalog.manifest.units
      .filter((unit) => unit.objectives.some((objective) => objective.objectiveId === objectiveId))
      .map((unit) => `${unit.unitId}@${registry.getActiveVersion(unit.unitId)}`)
      .sort();
    if (refs.length === 0) throw new Error(`cycle_objective_has_no_units:${objectiveId}`);
    const versionContentRef = `hook-versions:${refs.join(',')}`;
    return {
      version: `v-${createHash('sha256').update(versionContentRef).digest('hex').slice(0, 16)}`,
      versionContentRef,
    };
  }

  private async hydrateRollback(
    objectiveId: string,
    input: CycleGovernanceSubmission,
  ): Promise<HarnessGovernanceProposalChange> {
    if (!input.rollback || input.v2Draft) throw new Error('cycle_governance_rollback_target_required');
    const state = await this.requireUnit(objectiveId, input.rollback.unitId);
    const targetVersion = input.rollback.targetVersion;
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion >= state.version) {
      throw new Error('cycle_governance_rollback_target_invalid');
    }
    const targetContent =
      targetVersion === state.manifest.version
        ? await readFile(state.templatePath, 'utf8')
        : await this.deps.overrideStore.getVersionContent(state.manifest.id, targetVersion);
    if (targetContent === null) throw new Error('cycle_governance_rollback_target_missing');
    return {
      action: 'rollback',
      unitId: input.rollback.unitId,
      hookId: state.manifest.id,
      reason: input.reason.trim(),
      sourceVersion: state.version,
      targetVersion,
      beforeContent: state.content,
      targetContent,
    };
  }

  private async applyChange(
    change: HarnessGovernanceProposalChange,
    actorId: string,
    proposalReason: string,
  ): Promise<void> {
    if (change.action === 'add') return this.applyAdd(change);
    const registry = this.requireRegistry();
    const hook = registry.getHook(change.hookId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${change.hookId}`);
    const audit = { source: 'operator' as const, reason: `${proposalReason} — ${change.reason}` };
    if (change.action === 'enable' || change.action === 'disable') {
      return this.applyEnablement(change, hook, actorId, audit);
    }
    return this.applyContent(change, actorId, audit);
  }

  private async applyAdd(change: AddChange): Promise<void> {
    if (!this.deps.unitWriter) throw new Error('harness_governance_unit_writer_unavailable');
    await this.deps.unitWriter.add({
      unitId: change.unitId,
      assetSlug: change.assetSlug,
      manifest: change.manifest,
      content: change.content,
      objectives: change.objectives,
    });
  }

  private async applyEnablement(
    change: EnablementChange,
    hook: RegisteredHook,
    actorId: string,
    audit: OverrideAudit,
  ): Promise<void> {
    const current = await this.deps.overrideStore.getOverride(change.hookId);
    const enabled = current?.enabled ?? hook.manifest.enabled;
    const target = change.action === 'enable';
    if (enabled === target) return;
    await this.deps.overrideStore[change.action](change.hookId, actorId, audit);
  }

  private async applyContent(change: ContentChange, actorId: string, audit: OverrideAudit): Promise<void> {
    const version = await this.deps.overrideStore.getActiveVersion(change.hookId);
    const content = await this.effectiveContent(change.hookId);
    if (change.action === 'modify') {
      if (content === change.proposedContent) return;
      if (version !== change.sourceVersion) throw new Error('harness_governance_source_version_changed');
      await this.deps.overrideStore.setContentOverride(change.hookId, change.proposedContent, actorId, audit);
      return;
    }
    if (version === change.targetVersion && content === change.targetContent) return;
    if (version !== change.sourceVersion) throw new Error('harness_governance_source_version_changed');
    await this.deps.overrideStore.activateVersion(change.hookId, change.targetVersion, actorId, audit);
  }

  private async requireUnit(objectiveId: string, unitId: string) {
    const unit = this.deps.catalog.manifest.units.find((candidate) => candidate.unitId === unitId);
    if (!unit || !unit.objectives.some((objective) => objective.objectiveId === objectiveId)) {
      throw new Error(`cycle_governance_unit_not_attached:${unitId}`);
    }
    const registry = this.requireRegistry();
    const hook = registry.getHook(unit.unitId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${unit.unitId}`);
    return {
      ...hook,
      enabled: registry.isEnabled(unit.unitId),
      version: await this.deps.overrideStore.getActiveVersion(unit.unitId),
      content: await this.effectiveContent(unit.unitId),
    };
  }

  private validateAdd(objectiveId: string, unit: HarnessUnitAddDraft): void {
    if (!unit.objectives.some((attachment) => attachment.objectiveId === objectiveId)) {
      throw new Error('cycle_governance_add_must_attach_objective');
    }
    if (this.deps.catalog.manifest.units.some((candidate) => candidate.unitId === unit.unitId)) {
      throw new Error(`cycle_governance_add_unit_exists:${unit.unitId}`);
    }
    const registry = this.requireRegistry();
    if (
      registry.getHook(unit.unitId) ||
      registry.getStageHooks(unit.manifest.stage).some((hook) => hook.manifest.order === unit.manifest.order)
    ) {
      throw new Error('cycle_governance_add_registry_conflict');
    }
  }

  private async effectiveContent(hookId: string): Promise<string> {
    const registry = this.requireRegistry();
    const hook = registry.getHook(hookId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${hookId}`);
    return registry.getContentOverride(hookId) ?? readFile(hook.templatePath, 'utf8');
  }

  private requireRegistry(): HookRegistry {
    const registry = this.deps.getRegistry();
    if (!registry) throw new Error('harness_governance_registry_unavailable');
    return registry;
  }
}

function changeCoordinate(draft: HarnessGovernanceChangeDraft): string {
  const unitId = draft.action === 'add' ? draft.unit.unitId : draft.unitId;
  const field = draft.action === 'enable' || draft.action === 'disable' ? 'enablement' : 'content';
  return `${unitId}:${field}`;
}
