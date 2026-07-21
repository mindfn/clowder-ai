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
import { explainVerdict } from './verdict-explanations';

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
  return explainVerdict(epoch.eval.verdict).tone;
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
  return `eval(${explainVerdict(epoch.eval.verdict).label}${rate ? ` ${rate}` : ''})`;
}

/** Verdict explanation for the eval badge tooltip (判据③). */
function evalTitle(epoch: VersionEpoch): string | undefined {
  if (!epoch.eval || !epoch.eval.verdict) return undefined;
  return explainVerdict(epoch.eval.verdict).explanation;
}

function governanceLabel(epoch: VersionEpoch): string {
  if (!epoch.governance || !epoch.governance.decision) return 'governance';
  const label = epoch.governance.decision === 'pending' ? '待处理' : epoch.governance.decision;
  return `governance(${label})`;
}

// ── Helpers ────────────────────────────────────────────────────

function isSelected(selected: SelectedStage | null, version: number, stage: SelectedStage['stage']): boolean {
  return selected?.version === version && selected?.stage === stage;
}

/**
 * Actionable stage (判据①): a stage awaiting an OPERATOR decision — distinct from the
 * ACTIVE stage (which version is currently live, marked by `isActive`).
 *
 * Grounded in the producer: `segment-lifeline-chain.ts` sets governance = `pending`
 * exactly when the winning verdict is `alive`/`dormant` (lines 304-306), i.e. the
 * operator must approve/retire. `governance-pending` is the only operator-gated stage
 * in v1, so it is the sole actionable stage. Active ≠ actionable: the live version may
 * have nothing pending, and a non-active version may be the one awaiting a decision.
 */
export function isActionableStage(
  governance: { decision: string | null } | null | undefined,
  stage: SelectedStage['stage'],
): boolean {
  return stage === 'governance' && governance?.decision === 'pending';
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

      {/* Eval badge — verdict tone + hover explanation (判据③) */}
      <StageBadge
        label={evalLabel(epoch)}
        tone={evalTone(epoch)}
        title={evalTitle(epoch)}
        active={isSelected(selected, epoch.version, 'eval')}
        onClick={() => onSelect(epoch.version, 'eval')}
      />
      <Arrow />

      {/* Governance badge — active (selection) vs actionable (待处理) are separate channels (判据①) */}
      <StageBadge
        label={governanceLabel(epoch)}
        tone={governanceTone(epoch)}
        active={isSelected(selected, epoch.version, 'governance')}
        actionable={isActionableStage(epoch.governance, 'governance')}
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
  title,
  actionable = false,
  onClick,
}: {
  label: string;
  tone: BadgeTone;
  active: boolean;
  suffix?: string;
  title?: string;
  /** 判据①: stage awaits an operator decision — a separate visual channel from `active`. */
  actionable?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={actionable ? '待处理：需 operator 决策' : title}
      className={`relative cursor-pointer transition-all ${active ? 'ring-2 ring-[var(--console-active-ring)] ring-offset-1' : ''}`}
    >
      {actionable && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--color-amber-500)]"
        />
      )}
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
