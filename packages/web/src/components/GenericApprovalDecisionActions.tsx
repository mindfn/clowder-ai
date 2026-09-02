import type { ApprovalItem, EntityConflictContext, EntityConflictResolutionRequest } from '@cat-cafe/shared';
import { ApprovalProvenanceLinks } from './ApprovalProvenanceLinks';
import { EntityConflictResolutionPanel } from './EntityConflictResolutionPanel';
import { HarnessGovernanceDecisionActions } from './HarnessGovernanceDecisionActions';
import { PersonMemoryClaimSelector } from './PersonMemoryClaimSelector';

export function GenericApprovalDecisionActions({
  item,
  isStale,
  isResumeOnly,
  isPersonMemoryClaimSelect,
  entityConflict,
  decidingState,
  onApprove,
  onReject,
  onEntityResolution,
  onHarnessDecision,
  onBeforeNavigate,
}: {
  item: ApprovalItem;
  isStale: boolean;
  isResumeOnly: boolean;
  isPersonMemoryClaimSelect: boolean;
  entityConflict?: EntityConflictContext;
  decidingState?: string;
  onApprove: () => void;
  onReject: () => void;
  onEntityResolution: (resolution: EntityConflictResolutionRequest) => void;
  onHarnessDecision: (action: 'approve' | 'skip' | 'reject', note?: string) => void;
  onBeforeNavigate: () => void;
}) {
  const isHarnessGovernance = item.sourceFeatureId === 'F257' && item.decisionMode === 'approve-skip-reject';
  if (isHarnessGovernance) {
    return (
      <div className="space-y-2">
        <HarnessGovernanceDecisionActions decidingState={decidingState} onDecide={onHarnessDecision} />
        <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {entityConflict && (
        <EntityConflictResolutionPanel
          key={entityConflict.fingerprint}
          conflict={entityConflict}
          error={typeof item.detail.conflictError === 'string' ? item.detail.conflictError : undefined}
          deciding={Boolean(decidingState)}
          onResolve={onEntityResolution}
          onReject={onReject}
        />
      )}
      {isPersonMemoryClaimSelect && <PersonMemoryClaimSelector item={item} onReject={onReject} />}
      {!isPersonMemoryClaimSelect && (
        <DefaultApprovalDecisionActions
          item={item}
          isStale={isStale}
          isResumeOnly={isResumeOnly}
          entityConflict={entityConflict}
          decidingState={decidingState}
          onApprove={onApprove}
          onReject={onReject}
          onBeforeNavigate={onBeforeNavigate}
        />
      )}
      {isPersonMemoryClaimSelect && (
        <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
      )}
    </div>
  );
}

function DefaultApprovalDecisionActions({
  item,
  isStale,
  isResumeOnly,
  entityConflict,
  decidingState,
  onApprove,
  onReject,
  onBeforeNavigate,
}: {
  item: ApprovalItem;
  isStale: boolean;
  isResumeOnly: boolean;
  entityConflict?: EntityConflictContext;
  decidingState?: string;
  onApprove: () => void;
  onReject: () => void;
  onBeforeNavigate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {item.inlineApprovable && isResumeOnly && (
        <button
          type="button"
          onClick={onApprove}
          disabled={Boolean(decidingState)}
          className="rounded-md bg-[var(--semantic-warning)] px-3 py-1 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="resume-btn"
        >
          {decidingState === 'approving' ? '...' : '继续完成'}
        </button>
      )}
      {item.inlineApprovable && !isResumeOnly && !entityConflict && (
        <button
          type="button"
          onClick={onApprove}
          disabled={Boolean(decidingState)}
          className="rounded-md bg-[var(--semantic-success)] px-3 py-1 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="approve-btn"
        >
          {decidingState === 'approving' ? '...' : '批准'}
        </button>
      )}
      {!entityConflict && (
        <button
          type="button"
          onClick={onReject}
          disabled={Boolean(decidingState)}
          className="rounded-md border border-cafe px-3 py-1 text-micro font-medium hover:bg-[var(--semantic-error)] hover:text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="reject-btn"
        >
          {decidingState === 'rejecting' ? '...' : isStale ? '清除' : '拒绝'}
        </button>
      )}
      <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
    </div>
  );
}
