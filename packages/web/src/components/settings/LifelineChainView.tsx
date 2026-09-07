'use client';

/**
 * F257 — version and Objective-cycle lifecycle projection.
 *
 * A content version may survive several evaluation cycles. Each version keeps
 * one compact cycle card and expands a chooser on demand; parentVersion edges
 * form the visible tree so rollback branches do not need prose labels.
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

interface VersionTreeRow {
  epoch: VersionEpoch;
  depth: number;
  parentVersion: number | null;
  isLastSibling: boolean;
  hasChildren: boolean;
  ancestorContinuations: boolean[];
}

const TREE_STEP_PX = 52;
const VERSION_CENTER_PX = 16;

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

  const rows = flattenVersionTree(chain);

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        版本生命线
      </SettingsText>
      <div className="overflow-x-auto pb-1">
        <div className="min-w-max" data-version-tree>
          {rows.map((row) => {
            const { epoch } = row;
            const epochCycles = cyclesForEpoch(epoch, cycles);
            return (
              <EpochNode
                key={`${epoch.version}:${epoch.startedAt}`}
                epoch={epoch}
                cycles={epochCycles}
                currentCycleId={currentCycleId}
                selected={selected}
                onSelect={handleSelect}
                row={row}
              />
            );
          })}
        </div>
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
  row,
}: {
  epoch: VersionEpoch;
  cycles: SegmentCycleSummary[];
  currentCycleId: string | null;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
  row: VersionTreeRow;
}) {
  const { depth, parentVersion, isLastSibling, hasChildren, ancestorContinuations } = row;
  const selectedCycle = cycles.find((cycle) => cycle.cycleId === selected?.cycleId);
  const currentCycle = cycles.find((cycle) => cycle.cycleId === currentCycleId);
  const visibleCycle = selectedCycle ?? currentCycle ?? cycles.at(-1) ?? null;
  const visibleCycleIndex = visibleCycle ? cycles.findIndex((cycle) => cycle.cycleId === visibleCycle.cycleId) : -1;

  return (
    <div
      data-version-node={epoch.version}
      data-parent-version={epoch.parentVersion ?? undefined}
      data-tree-depth={depth}
      className="relative min-h-11 min-w-0 py-1"
    >
      <VersionTreeConnectors
        version={epoch.version}
        depth={depth}
        parentVersion={parentVersion}
        isLastSibling={isLastSibling}
        hasChildren={hasChildren}
        ancestorContinuations={ancestorContinuations}
      />
      <div
        className="relative z-[1] flex min-w-0 items-center gap-1.5"
        style={{ paddingInlineStart: `${depth * TREE_STEP_PX}px` }}
      >
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
              localOrdinal={visibleCycleIndex + 1}
              cycles={cycles}
              isCurrentCycle={
                visibleCycle.cycleId === currentCycleId || (!currentCycleId && visibleCycle.closedAt == null)
              }
              selected={selected}
              onSelect={onSelect}
            />
          </>
        ) : (
          <>
            <Arrow />
            <LegacyCycleStages epoch={epoch} selected={selected} onSelect={onSelect} />
          </>
        )}
      </div>
    </div>
  );
}

function VersionTreeConnectors({
  version,
  depth,
  parentVersion,
  isLastSibling,
  hasChildren,
  ancestorContinuations,
}: {
  version: number;
  depth: number;
  parentVersion: number | null;
  isLastSibling: boolean;
  hasChildren: boolean;
  ancestorContinuations: boolean[];
}) {
  const nodeCenter = depth * TREE_STEP_PX + VERSION_CENTER_PX;
  const parentCenter = (depth - 1) * TREE_STEP_PX + VERSION_CENTER_PX;

  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 text-cafe-muted">
      {ancestorContinuations.map((continues, level) =>
        continues ? (
          <span
            // The level is structural and stable inside one ancestry path.
            // biome-ignore lint/suspicious/noArrayIndexKey: connector rails have no entity identity
            key={level}
            data-version-ancestor-rail={level}
            className="absolute inset-y-0 border-l border-[var(--console-border)]"
            style={{ left: `${level * TREE_STEP_PX + VERSION_CENTER_PX}px` }}
          />
        ) : null,
      )}
      {depth > 0 && parentVersion !== null && (
        <span data-version-edge={`${parentVersion}:${version}`}>
          <span
            className="absolute top-0 border-l border-[var(--console-border)]"
            style={{ left: `${parentCenter}px`, bottom: isLastSibling ? '50%' : 0 }}
          />
          <span
            className="absolute border-t border-[var(--console-border)]"
            style={{
              left: `${parentCenter}px`,
              top: '50%',
              width: `${TREE_STEP_PX - VERSION_CENTER_PX - 4}px`,
            }}
          />
          <span
            className="absolute -translate-y-1/2 text-xs leading-none"
            style={{ left: `${depth * TREE_STEP_PX - 7}px`, top: '50%' }}
          >
            ›
          </span>
        </span>
      )}
      {hasChildren && (
        <span
          data-version-child-rail={version}
          className="absolute bottom-0 border-l border-[var(--console-border)]"
          style={{ left: `${nodeCenter}px`, top: '50%' }}
        />
      )}
    </span>
  );
}

function CycleStages({
  version,
  cycle,
  localOrdinal,
  cycles,
  isCurrentCycle,
  selected,
  onSelect,
}: {
  version: number;
  cycle: SegmentCycleSummary;
  localOrdinal: number;
  cycles: SegmentCycleSummary[];
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
      <select
        data-cycle-switcher
        aria-label={`v${version} 周期`}
        value={cycle.cycleId}
        onChange={(event) => {
          const next = cycles.find((candidate) => candidate.cycleId === event.currentTarget.value);
          if (next) onSelect(version, activeStageForCycle(next), next.cycleId);
        }}
        className="ml-1 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2 py-0.5 text-micro text-cafe-secondary outline-none focus:border-cafe-accent"
        title={`当前为本版本周期 ${localOrdinal}；周期起点：${new Date(cycle.cycleStart).toLocaleString()}`}
      >
        {cycles.map((candidate, index) => (
          <option
            key={candidate.cycleId}
            data-cycle-option
            data-option-cycle-id={candidate.cycleId}
            value={candidate.cycleId}
          >
            周期 {index + 1}
          </option>
        ))}
      </select>
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

function cyclesForEpoch(epoch: VersionEpoch, cycles: SegmentCycleSummary[]): SegmentCycleSummary[] {
  return cycles
    .filter((cycle) => cycle.segmentVersion === epoch.version)
    .sort((left, right) => left.cycleStart - right.cycleStart || left.cycleId.localeCompare(right.cycleId));
}

function flattenVersionTree(chain: VersionEpoch[]): VersionTreeRow[] {
  const byVersion = new Map(chain.map((epoch) => [epoch.version, epoch] as const));
  const childrenByParent = new Map<number, VersionEpoch[]>();
  const roots: VersionEpoch[] = [];

  for (const epoch of chain) {
    const parentVersion = epoch.parentVersion;
    if (parentVersion === null || parentVersion === epoch.version || !byVersion.has(parentVersion)) {
      roots.push(epoch);
      continue;
    }
    const siblings = childrenByParent.get(parentVersion) ?? [];
    siblings.push(epoch);
    childrenByParent.set(parentVersion, siblings);
  }

  const rows: VersionTreeRow[] = [];
  const visited = new Set<number>();
  const visit = (
    epoch: VersionEpoch,
    depth: number,
    parentVersion: number | null,
    isLastSibling: boolean,
    ancestorContinuations: boolean[],
  ) => {
    if (visited.has(epoch.version)) return;
    visited.add(epoch.version);
    const children = (childrenByParent.get(epoch.version) ?? []).filter((child) => !visited.has(child.version));
    rows.push({
      epoch,
      depth,
      parentVersion,
      isLastSibling,
      hasChildren: children.length > 0,
      ancestorContinuations,
    });
    children.forEach((child, index) => {
      const childContinuations = depth === 0 ? [] : [...ancestorContinuations, !isLastSibling];
      visit(child, depth + 1, epoch.version, index === children.length - 1, childContinuations);
    });
  };

  roots.forEach((root, index) => {
    visit(root, 0, null, index === roots.length - 1, []);
  });
  // Corrupt/cyclic ancestry must remain visible rather than silently dropping versions.
  chain.forEach((epoch) => {
    if (!visited.has(epoch.version)) visit(epoch, 0, null, true, []);
  });
  return rows;
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
