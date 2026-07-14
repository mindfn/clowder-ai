'use client';

/**
 * F257 Phase D — Version lifecycle chain visualization.
 *
 * Horizontal scrollable chain of version epochs:
 *   [v1] → [tracing(445)] → [eval(pass)] → [governance] → [v2] → [tracing(12)] → ...
 *
 * Each badge is clickable — selecting a stage shows its detail in LifelineStageDetail.
 */

import { useCallback } from 'react';
import { SettingsBadge, SettingsText } from './primitives';

// ── Types ──────────────────────────────────────────────────────

interface VersionEpoch {
  version: number;
  origin: string;
  startedAt: number;
  status: string;
  isActive: boolean;
  tracing: { observationCount: number; firstAt: number | null; lastAt: number | null } | null;
  eval: { verdict: string | null; injectionCount: number; violationCount: number; evaluatedAt: number | null } | null;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  events: Array<{ eventId: string; kind: string; timestamp: number; actorId: string; detail: string }>;
}

export interface SelectedStage {
  version: number;
  stage: 'version' | 'tracing' | 'eval' | 'governance';
}

interface LifelineChainViewProps {
  chain: VersionEpoch[];
  selected: SelectedStage | null;
  onSelect: (stage: SelectedStage) => void;
}

// ── Badge tone mapping ─────────────────────────────────────────

type BadgeTone = 'emerald' | 'amber' | 'red' | 'blue' | 'slate';

function versionTone(epoch: VersionEpoch): BadgeTone {
  return epoch.isActive ? 'blue' : 'slate';
}

function tracingTone(epoch: VersionEpoch): BadgeTone {
  if (!epoch.tracing || epoch.tracing.observationCount === 0) return 'slate';
  return 'emerald';
}

function evalTone(epoch: VersionEpoch): BadgeTone {
  if (!epoch.eval || !epoch.eval.verdict) return 'slate';
  if (epoch.eval.verdict === 'alive') return 'emerald';
  if (epoch.eval.verdict === 'dormant' || epoch.eval.verdict === 'retire-candidate') return 'red';
  return 'amber';
}

function governanceTone(epoch: VersionEpoch): BadgeTone {
  if (!epoch.governance || !epoch.governance.decision) return 'slate';
  if (epoch.governance.decision === 'approved') return 'emerald';
  return 'amber';
}

// ── Labels ─────────────────────────────────────────────────────

function tracingLabel(epoch: VersionEpoch): string {
  if (!epoch.tracing || epoch.tracing.observationCount === 0) return 'tracing';
  return `tracing(${epoch.tracing.observationCount})`;
}

function evalLabel(epoch: VersionEpoch): string {
  if (!epoch.eval || !epoch.eval.verdict) return 'eval';
  const ic = epoch.eval.injectionCount;
  const vc = epoch.eval.violationCount;
  const rate = ic > 0 ? `${((vc / ic) * 100).toFixed(0)}%` : '';
  return `eval(${epoch.eval.verdict}${rate ? ` ${rate}` : ''})`;
}

function governanceLabel(epoch: VersionEpoch): string {
  if (!epoch.governance || !epoch.governance.decision) return 'governance';
  return `governance(${epoch.governance.decision})`;
}

// ── Helpers ────────────────────────────────────────────────────

function isSelected(selected: SelectedStage | null, version: number, stage: SelectedStage['stage']): boolean {
  return selected?.version === version && selected?.stage === stage;
}

// ── Component ──────────────────────────────────────────────────

export function LifelineChainView({ chain, selected, onSelect }: LifelineChainViewProps) {
  const handleSelect = useCallback(
    (version: number, stage: SelectedStage['stage']) => {
      onSelect({ version, stage });
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
        {chain.map((epoch, idx) => (
          <EpochNode
            key={epoch.version}
            epoch={epoch}
            selected={selected}
            onSelect={handleSelect}
            showArrowBefore={idx > 0}
          />
        ))}
      </div>
    </div>
  );
}

// ── Epoch node ─────────────────────────────────────────────────

function EpochNode({
  epoch,
  selected,
  onSelect,
  showArrowBefore,
}: {
  epoch: VersionEpoch;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage']) => void;
  showArrowBefore: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showArrowBefore && <Arrow />}

      {/* Version badge */}
      <StageBadge
        label={`v${epoch.version}`}
        tone={versionTone(epoch)}
        active={isSelected(selected, epoch.version, 'version')}
        suffix={epoch.isActive ? '●' : undefined}
        onClick={() => onSelect(epoch.version, 'version')}
      />
      <Arrow />

      {/* Tracing badge */}
      <StageBadge
        label={tracingLabel(epoch)}
        tone={tracingTone(epoch)}
        active={isSelected(selected, epoch.version, 'tracing')}
        onClick={() => onSelect(epoch.version, 'tracing')}
      />
      <Arrow />

      {/* Eval badge */}
      <StageBadge
        label={evalLabel(epoch)}
        tone={evalTone(epoch)}
        active={isSelected(selected, epoch.version, 'eval')}
        onClick={() => onSelect(epoch.version, 'eval')}
      />
      <Arrow />

      {/* Governance badge */}
      <StageBadge
        label={governanceLabel(epoch)}
        tone={governanceTone(epoch)}
        active={isSelected(selected, epoch.version, 'governance')}
        onClick={() => onSelect(epoch.version, 'governance')}
      />
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────

function StageBadge({
  label,
  tone,
  active,
  suffix,
  onClick,
}: {
  label: string;
  tone: BadgeTone;
  active: boolean;
  suffix?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer transition-all ${active ? 'ring-2 ring-[var(--console-active-ring)] ring-offset-1' : ''}`}
    >
      <SettingsBadge tone={tone} size="xxs">
        {label}
        {suffix && <span className="ml-1 text-[10px]">{suffix}</span>}
      </SettingsBadge>
    </button>
  );
}

function Arrow() {
  return <span className="text-[10px] text-cafe-muted">→</span>;
}
