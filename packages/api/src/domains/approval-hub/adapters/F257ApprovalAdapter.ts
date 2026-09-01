/** F257 Harness Governance Candidate → Approval Hub projection. */

import type { ApprovalItem, Candidate, SettledApprovalItem } from '@cat-cafe/shared';
import type { CandidateStore } from '../../../infrastructure/harness-eval/governance/CandidateStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

const DEFAULT_SETTLED_LIMIT = 50;

export class F257ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F257' as const;

  constructor(private readonly store: CandidateStore | undefined) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    if (!this.store) return [];
    const candidates = await this.store.listByOwner(userId);
    const items = await Promise.all(
      candidates
        .filter((candidate) => candidate.status === 'proposed' || candidate.status === 'executing')
        .map((candidate) => this.toPending(candidate)),
    );
    return items.filter((item): item is ApprovalItem => item !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    if (!this.store) return [];
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    const candidates = await this.store.listByOwner(userId);
    const items = await Promise.all(
      candidates
        .filter((candidate) => candidate.status !== 'proposed' && candidate.status !== 'executing')
        .map((candidate) => this.toSettled(candidate)),
    );
    return items
      .filter((item): item is SettledApprovalItem => item !== null)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);
  }

  private async toPending(candidate: Candidate): Promise<ApprovalItem | null> {
    const context = await this.store?.getEvaluationContext(candidate.candidateId);
    if (!context) return null;
    return {
      proposalId: candidate.candidateId,
      sourceFeatureId: 'F257',
      requesterCatId: 'system',
      ownerUserId: context.ownerUserId,
      status: 'pending',
      summary: summary(candidate),
      detail: detail(candidate, context),
      navigation: { state: 'legacy_unanchored' },
      inlineApprovable: true,
      ...(candidate.status === 'executing' ? { decisionMode: 'resume-only' as const } : {}),
      createdAt: context.createdAt,
    };
  }

  private async toSettled(candidate: Candidate): Promise<SettledApprovalItem | null> {
    const context = await this.store?.getEvaluationContext(candidate.candidateId);
    const decidedAt = candidate.approval.decidedAt ? Date.parse(candidate.approval.decidedAt) : Number.NaN;
    if (!context || !Number.isFinite(decidedAt)) return null;
    const decidedBy = candidate.status === 'rejected' ? context.ownerUserId : candidate.approval.approvedBy;
    if (!decidedBy) return null;
    return {
      proposalId: candidate.candidateId,
      sourceFeatureId: 'F257',
      requesterCatId: 'system',
      ownerUserId: context.ownerUserId,
      status: candidate.status === 'rejected' ? 'rejected' : 'approved',
      summary: summary(candidate),
      detail: detail(candidate, context),
      navigation: { state: 'legacy_unanchored' },
      decidedAt,
      decidedBy,
      createdAt: context.createdAt,
    };
  }
}

function summary(candidate: Candidate): string {
  const segments = candidate.targetSegmentIds.join(', ');
  if (candidate.proposedAction.contentDraft) return `Harness 治理：更新 ${segments} 内容`;
  if (candidate.proposedAction.rollbackToVersion !== undefined) {
    return `Harness 治理：回退 ${segments} 到 v${candidate.proposedAction.rollbackToVersion}`;
  }
  return `Harness 治理：处理 ${segments}`;
}

function detail(
  candidate: Candidate,
  context: NonNullable<Awaited<ReturnType<CandidateStore['getEvaluationContext']>>>,
): Record<string, unknown> {
  return {
    candidateType: candidate.type,
    targetSegmentIds: [...candidate.targetSegmentIds],
    proposedAction: structuredClone(candidate.proposedAction),
    evidence: structuredClone(candidate.evidence),
    candidateStatus: candidate.status,
    judgmentId: context.judgmentId,
    objectiveId: context.objectiveId,
    baselineEvaluationModelVersion: context.baselineEvaluationModelVersion,
    baseline: structuredClone(context.baseline),
    baselineMetricId: context.baselineMetricId,
    baselineTraceHash: context.baselineTraceHash,
  };
}
