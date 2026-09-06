'use client';

/**
 * F257 — version and Objective-cycle lifecycle projection.
 *
 * A content version may survive several evaluation cycles. The line therefore
 * renders one version node followed by every tracing → eval → governance loop
 * that happened while that version was active.
 */

import type { SegmentCycleSummary, VersionEpoch } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { explainVerdict } from './verdict-explanations';

export interface SelectedStage {
  version: number;
  stage: 'version' | 'tracing' | 'eval' | 'governance';
  cycleId?: string;
}

interface LifelineChainViewProps {
  chain: VersionEpoch[];
  cycles?: SegmentCycleSummary[];
  currentCycleId?: string | null;
  selected: SelectedStage | null;
  onSelect: (stage: SelectedStage) => void;
}

export function LifelineChainView({
  chain,
  cycles = [],
  currentCycleId = null,
  selected,
  onSelect,
}: LifelineChainViewProps) {
  const handleSelect = useCallback(
    (version: number, stage: SelectedStage['stage'], cycleId?: string) => {
      onSelect({ version, stage, ...(cycleId ? { cycleId } : {}) });
    },
    [onSelect],
  );

  if (chain.length === 0) {
    return (
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        无生命线数据
      </SettingsText>
    );
  }

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        版本生命线
      </SettingsText>
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2">
        {chain.map((epoch, index) => {
          const epochCycles = cyclesForEpoch(chain, index, cycles);
          return (
            <EpochNode
              key={`${epoch.version}:${epoch.startedAt}`}
              epoch={epoch}
              cycles={epochCycles}
              currentCycleId={currentCycleId}
              selected={selected}
              onSelect={handleSelect}
              showArrowBefore={index > 0}
            />
          );
        })}
      </div>
    </div>
  );
}

function EpochNode({
  epoch,
  cycles,
  currentCycleId,
  selected,
  onSelect,
  showArrowBefore,
}: {
  epoch: VersionEpoch;
  cycles: SegmentCycleSummary[];
  currentCycleId: string | null;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
  showArrowBefore: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showArrowBefore && <Arrow />}
      <StageBadge
        label={`v${epoch.version}`}
        stage="version"
        selected={isSelected(selected, epoch.version, 'version')}
        current={epoch.isActive && cycles.length === 0 && epoch.status === 'idle'}
        onClick={() => onSelect(epoch.version, 'version')}
      />

      {cycles.length > 0 ? (
        cycles.map((cycle) => (
          <CycleStages
            key={cycle.cycleId}
            version={epoch.version}
            cycle={cycle}
            isCurrentCycle={cycle.cycleId === currentCycleId || (!currentCycleId && cycle.closedAt == null)}
            selected={selected}
            onSelect={onSelect}
          />
        ))
      ) : (
        <LegacyCycleStages epoch={epoch} selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}

function CycleStages({
  version,
  cycle,
  isCurrentCycle,
  selected,
  onSelect,
}: {
  version: number;
  cycle: SegmentCycleSummary;
  isCurrentCycle: boolean;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
}) {
  const currentStage = isCurrentCycle ? activeStageForCycle(cycle) : null;
  const stages: Array<{ stage: 'tracing' | 'eval' | 'governance'; title: string }> = [
    { stage: 'tracing', title: `周期起点：${new Date(cycle.cycleStart).toLocaleString()}` },
    {
      stage: 'eval',
      title: cycle.evaluation ? `评估已回写：${cycle.evaluation.overall}` : '等待本周期评估',
    },
    {
      stage: 'governance',
      title: cycle.governance ? `治理结论：${cycle.governance.decision}` : '等待本周期治理',
    },
  ];

  return (
    <>
      {stages.map(({ stage, title }) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          <Arrow />
          <StageBadge
            label={stage}
            stage={stage}
            cycleId={cycle.cycleId}
            title={title}
            selected={isSelected(selected, version, stage, cycle.cycleId)}
            current={currentStage === stage}
            onClick={isCurrentCycle ? () => onSelect(version, stage, cycle.cycleId) : undefined}
          />
        </span>
      ))}
    </>
  );
}

/** Compatibility while cycle data is loading or unavailable. */
function LegacyCycleStages({
  epoch,
  selected,
  onSelect,
}: {
  epoch: VersionEpoch;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
}) {
  const currentStage = epoch.isActive ? legacyActiveStage(epoch) : null;
  const evalTitle = explainVerdict(epoch.eval?.verdict).explanation;
  const stages: Array<{ stage: 'tracing' | 'eval' | 'governance'; title?: string }> = [
    { stage: 'tracing' },
    { stage: 'eval', title: evalTitle },
    { stage: 'governance' },
  ];
  return (
    <>
      {stages.map(({ stage, title }) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          <Arrow />
          <StageBadge
            label={stage}
            stage={stage}
            title={title}
            selected={isSelected(selected, epoch.version, stage)}
            current={currentStage === stage}
            onClick={() => onSelect(epoch.version, stage)}
          />
        </span>
      ))}
    </>
  );
}

function StageBadge({
  label,
  stage,
  cycleId,
  selected,
  current,
  title,
  onClick,
}: {
  label: string;
  stage: SelectedStage['stage'];
  cycleId?: string;
  selected: boolean;
  current: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const className = `rounded-full transition-all ${onClick ? 'cursor-pointer active:scale-[0.98]' : ''} ${
    selected && !current ? 'ring-1 ring-[var(--console-border)]' : ''
  }`;
  const badge = (
    <SettingsBadge
      tone="slate"
      size="xxs"
      className={
        current ? '!bg-cafe-accent !text-[var(--cafe-accent-foreground)] shadow-[var(--shadow-elevation-1)]' : undefined
      }
    >
      {label}
    </SettingsBadge>
  );
  const sharedProps = {
    title,
    'aria-current': current ? ('step' as const) : undefined,
    'data-stage': stage,
    'data-cycle-id': cycleId,
    'data-current': String(current),
    className,
  };

  if (!onClick) return <span {...sharedProps}>{badge}</span>;
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} {...sharedProps}>
      {badge}
    </button>
  );
}

function cyclesForEpoch(chain: VersionEpoch[], index: number, cycles: SegmentCycleSummary[]): SegmentCycleSummary[] {
  const epoch = chain[index];
  const nextStartedAt = chain[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
  return cycles
    .filter((cycle) => cycle.cycleStart >= epoch.startedAt && cycle.cycleStart < nextStartedAt)
    .sort((left, right) => left.cycleStart - right.cycleStart || left.cycleId.localeCompare(right.cycleId));
}

function activeStageForCycle(cycle: SegmentCycleSummary): 'tracing' | 'eval' | 'governance' {
  if (cycle.evalStatus === 'idle') return 'tracing';
  if (cycle.evalStatus === 'requested' || cycle.evalStatus === 'retriggered' || cycle.evalStatus === 'stalled') {
    return 'eval';
  }
  return 'governance';
}

function legacyActiveStage(epoch: VersionEpoch): 'tracing' | 'eval' | 'governance' {
  if (epoch.status === 'eval-pending') return 'eval';
  if (epoch.status === 'governance-pending' || epoch.status === 'governance-approved' || epoch.status === 'eval-pass') {
    return 'governance';
  }
  return 'tracing';
}

function isSelected(
  selected: SelectedStage | null,
  version: number,
  stage: SelectedStage['stage'],
  cycleId?: string,
): boolean {
  return (
    selected?.version === version && selected.stage === stage && (stage === 'version' || selected.cycleId === cycleId)
  );
}

function Arrow() {
  return <span className="text-micro text-cafe-muted">→</span>;
}
