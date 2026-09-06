'use client';

/**
 * F257 — version and Objective-cycle lifecycle projection.
 *
 * A content version may survive several evaluation cycles. Each version keeps
 * one compact cycle card and expands a chooser on demand; version ancestry is
 * vertical so rollback branches remain truthful without an unbounded row.
 */

import type { SegmentCycleSummary, VersionActivation, VersionEpoch } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
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
  versionActivations?: VersionActivation[];
  currentCycleId?: string | null;
  selected: SelectedStage | null;
  onSelect: (stage: SelectedStage) => void;
}

export function LifelineChainView({
  chain,
  cycles = [],
  versionActivations = [],
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
      <div className="space-y-2" data-version-tree>
        {chain.map((epoch, index) => {
          const epochCycles = cyclesForEpoch(chain, index, cycles, versionActivations);
          return (
            <EpochNode
              key={`${epoch.version}:${epoch.startedAt}`}
              epoch={epoch}
              cycles={epochCycles}
              currentCycleId={currentCycleId}
              selected={selected}
              onSelect={handleSelect}
              depth={versionDepth(epoch, chain)}
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
  depth,
}: {
  epoch: VersionEpoch;
  cycles: SegmentCycleSummary[];
  currentCycleId: string | null;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectedCycle = cycles.find((cycle) => cycle.cycleId === selected?.cycleId);
  const currentCycle = cycles.find((cycle) => cycle.cycleId === currentCycleId);
  const visibleCycle = selectedCycle ?? currentCycle ?? cycles.at(-1) ?? null;
  const visibleCycleIndex = visibleCycle ? cycles.findIndex((cycle) => cycle.cycleId === visibleCycle.cycleId) : -1;

  return (
    <div
      data-version-node={epoch.version}
      data-parent-version={epoch.parentVersion ?? undefined}
      className="min-w-0"
      style={{ paddingInlineStart: `${Math.min(depth, 4) * 18}px` }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {epoch.parentVersion !== null && (
          <span className="flex items-center gap-1 text-micro text-cafe-muted" title={`源自 v${epoch.parentVersion}`}>
            <span aria-hidden="true">↳</span>
            <span>源自 v{epoch.parentVersion}</span>
          </span>
        )}
        <StageBadge
          label={`v${epoch.version}`}
          stage="version"
          selected={isSelected(selected, epoch.version, 'version')}
          current={epoch.isActive && cycles.length === 0 && epoch.status === 'idle'}
          onClick={() => onSelect(epoch.version, 'version')}
        />

        {visibleCycle ? (
          <>
            <Arrow />
            <CycleStages
              version={epoch.version}
              cycle={visibleCycle}
              ordinal={visibleCycle.ordinal ?? visibleCycleIndex + 1}
              total={cycles.length}
              expanded={expanded}
              isCurrentCycle={
                visibleCycle.cycleId === currentCycleId || (!currentCycleId && visibleCycle.closedAt == null)
              }
              selected={selected}
              onSelect={onSelect}
              onToggle={() => setExpanded((value) => !value)}
            />
          </>
        ) : (
          <>
            <Arrow />
            <LegacyCycleStages epoch={epoch} selected={selected} onSelect={onSelect} />
          </>
        )}
      </div>
      {expanded && cycles.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-cycle-options>
          {cycles.map((cycle, index) => (
            <button
              key={cycle.cycleId}
              type="button"
              data-cycle-option
              data-option-cycle-id={cycle.cycleId}
              aria-pressed={cycle.cycleId === visibleCycle?.cycleId}
              className="rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2.5 py-1 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)]"
              onClick={() => {
                setExpanded(false);
                onSelect(epoch.version, activeStageForCycle(cycle), cycle.cycleId);
              }}
            >
              第 {cycle.ordinal ?? index + 1} 周期
              {cycle.cycleId === currentCycleId ? ' · 当前' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CycleStages({
  version,
  cycle,
  ordinal,
  total,
  expanded,
  isCurrentCycle,
  selected,
  onSelect,
  onToggle,
}: {
  version: number;
  cycle: SegmentCycleSummary;
  ordinal: number;
  total: number;
  expanded: boolean;
  isCurrentCycle: boolean;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
  onToggle: () => void;
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
    <div
      data-cycle-group={cycle.cycleId}
      className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-xl bg-[var(--console-elevated-bg)] px-2 py-1.5"
    >
      {stages.map(({ stage, title }, index) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          {index > 0 && <Arrow />}
          <StageBadge
            label={stage}
            stage={stage}
            cycleId={cycle.cycleId}
            title={title}
            selected={isSelected(selected, version, stage, cycle.cycleId)}
            current={currentStage === stage}
            onClick={() => onSelect(version, stage, cycle.cycleId)}
          />
        </span>
      ))}
      {total > 1 ? (
        <button
          type="button"
          data-cycle-switcher
          aria-expanded={expanded}
          onClick={onToggle}
          className="ml-1 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2 py-0.5 text-micro text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)]"
          title={`周期起点：${new Date(cycle.cycleStart).toLocaleString()}`}
        >
          第 {ordinal} 周期 · 选择
        </button>
      ) : (
        <span
          className="ml-1 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2 py-0.5 text-micro text-cafe-muted"
          title={`周期起点：${new Date(cycle.cycleStart).toLocaleString()}`}
        >
          第 {ordinal} 周期
        </span>
      )}
    </div>
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
    <div
      data-cycle-group={`legacy-v${epoch.version}`}
      className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--console-border-soft)] px-2 py-1.5"
    >
      {stages.map(({ stage, title }) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          {stage !== 'tracing' && <Arrow />}
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
    </div>
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
  const className = `rounded-full transition-all ${onClick ? 'cursor-pointer active:scale-[0.98]' : ''}`;
  const badge = (
    <SettingsBadge
      tone="slate"
      size="xxs"
      className={
        selected
          ? '!bg-cafe-accent !text-[var(--cafe-accent-foreground)] shadow-[var(--shadow-elevation-1)]'
          : undefined
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

function cyclesForEpoch(
  chain: VersionEpoch[],
  index: number,
  cycles: SegmentCycleSummary[],
  activations: VersionActivation[],
): SegmentCycleSummary[] {
  const epoch = chain[index];
  if (activations.length > 0) {
    return cycles
      .filter((cycle) => activeVersionAt(activations, cycle.cycleStart, chain[0]?.version) === epoch.version)
      .sort((left, right) => left.cycleStart - right.cycleStart || left.cycleId.localeCompare(right.cycleId));
  }
  const nextStartedAt = chain[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
  return cycles
    .filter((cycle) => cycle.cycleStart >= epoch.startedAt && cycle.cycleStart < nextStartedAt)
    .sort((left, right) => left.cycleStart - right.cycleStart || left.cycleId.localeCompare(right.cycleId));
}

export function activeVersionAt(
  activations: VersionActivation[],
  timestamp: number,
  fallback?: number,
): number | undefined {
  let version = fallback;
  for (const activation of activations) {
    if (activation.timestamp > timestamp) break;
    version = activation.version;
  }
  return version;
}

function versionDepth(epoch: VersionEpoch, chain: VersionEpoch[]): number {
  const byVersion = new Map(chain.map((candidate) => [candidate.version, candidate] as const));
  const visited = new Set<number>();
  let parentVersion = epoch.parentVersion;
  let depth = 0;
  while (parentVersion !== null && !visited.has(parentVersion)) {
    visited.add(parentVersion);
    depth++;
    parentVersion = byVersion.get(parentVersion)?.parentVersion ?? null;
  }
  return depth;
}

export function activeStageForCycle(cycle: SegmentCycleSummary): 'tracing' | 'eval' | 'governance' {
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
