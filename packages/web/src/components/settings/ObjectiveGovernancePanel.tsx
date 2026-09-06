'use client';

import type { SegmentCycleSummary, SegmentEvaluationResponse } from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';

const formatTs = (value: number) => new Date(value).toLocaleString();

export function ObjectiveGovernancePanel({ data }: { data: SegmentEvaluationResponse }) {
  if (data.objectives.length === 0) {
    return <EmptyCard text="该段尚未挂接 Objective，因此没有治理周期。" />;
  }
  return (
    <div className="space-y-4" data-testid="objective-governance-panel">
      {data.objectives.map((objective) => (
        <section key={objective.objectiveId} className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
              {objective.objectiveLabel}
            </SettingsText>
            <SettingsBadge tone="slate" size="xxs">
              {objective.objectiveId}
            </SettingsBadge>
          </div>
          {objective.latestGovernance ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <MetaRow label="decision">
                <SettingsBadge tone={decisionTone(objective.latestGovernance.decision)} size="xxs">
                  {decisionLabel(objective.latestGovernance.decision)}
                </SettingsBadge>
              </MetaRow>
              <MetaRow label="治理时间">{formatTs(objective.latestGovernance.writtenAt)}</MetaRow>
              <MetaRow label="决策者">@{objective.latestGovernance.by}</MetaRow>
              <MetaRow label="理由">{objective.latestGovernance.reason}</MetaRow>
              <MetaRow label="审批卡">
                {objective.latestGovernance.approval ? (
                  <>
                    <ApprovalBadge state={objective.latestGovernance.approval.state} />
                    {objective.latestGovernance.approval.cardId && (
                      <span className="ml-2 font-mono">{objective.latestGovernance.approval.cardId}</span>
                    )}
                  </>
                ) : (
                  'keep 无需审批卡'
                )}
              </MetaRow>
              {objective.latestGovernance.approval?.reason && (
                <MetaRow label="审批理由">{objective.latestGovernance.approval.reason}</MetaRow>
              )}
            </div>
          ) : (
            <SettingsText as="p" variant="xs" tone="muted" className="mt-3">
              {objective.selectedCycle?.evalStatus === 'written'
                ? '本周期评估已回写，尚未形成 governance 决策。'
                : '本周期尚未进入 governance。'}
            </SettingsText>
          )}
        </section>
      ))}
    </div>
  );
}

function ApprovalBadge({ state }: { state: NonNullable<SegmentCycleSummary['approval']>['state'] }) {
  return (
    <SettingsBadge tone={state === 'approved' ? 'emerald' : state === 'rejected' ? 'red' : 'amber'} size="xxs">
      {approvalLabel(state)}
    </SettingsBadge>
  );
}

function decisionLabel(decision: NonNullable<SegmentCycleSummary['governance']>['decision']) {
  return { keep: '保持', rollback: '回退', evolve: '演进' }[decision];
}

function decisionTone(decision: NonNullable<SegmentCycleSummary['governance']>['decision']) {
  return decision === 'keep' ? ('emerald' as const) : ('amber' as const);
}

function approvalLabel(state: NonNullable<SegmentCycleSummary['approval']>['state']) {
  return { pending: '待审批', approved: '已批准', skipped: '已跳过', rejected: '已拒绝' }[state];
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[76px] shrink-0 text-cafe-muted">{label}</span>
      <span className="min-w-0 text-cafe-secondary">{children}</span>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <SettingsText as="p" variant="xs" tone="muted">
        {text}
      </SettingsText>
    </div>
  );
}
