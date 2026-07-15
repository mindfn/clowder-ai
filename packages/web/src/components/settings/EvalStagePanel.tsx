'use client';

/**
 * F257 Phase D — Eval stage detail panel.
 *
 * Shows evaluation metrics for a version epoch:
 *   - With verdict: judgment result + injection/violation stats
 *   - Pending: observation count, guard events, trigger progress bar
 *
 * Extracted from LifelineStageDetail to stay within 350-line limit.
 */

import { SettingsBadge, SettingsText } from './primitives';

// ── Types ────────────────────────────────────────────────────────

interface EvalStageSummary {
  verdict: string | null;
  injectionCount: number;
  violationCount: number;
  evaluatedAt: number | null;
}

interface TracingStageSummary {
  observationCount: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface EvalDetailProps {
  version: number;
  eval: EvalStageSummary | null;
  tracing: TracingStageSummary | null;
  guardEventCount: number;
}

// ── Constants ────────────────────────────────────────────────────

/** Eval trigger threshold: ≥3 guard events within 7-day window. */
const EVAL_TRIGGER_THRESHOLD = 3;

const formatTs = (ms: number) => new Date(ms).toLocaleString();

// ── Components ───────────────────────────────────────────────────

export function EvalStagePanel({ version, eval: evalData, tracing, guardEventCount }: EvalDetailProps) {
  const obsCount = tracing?.observationCount ?? 0;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{version} — Eval
      </SettingsText>

      {evalData?.verdict ? (
        <div className="space-y-2">
          <InfoRow label="判定">
            <SettingsBadge
              tone={evalData.verdict === 'alive' ? 'emerald' : evalData.verdict === 'dormant' ? 'red' : 'amber'}
              size="xxs"
            >
              {evalData.verdict}
            </SettingsBadge>
          </InfoRow>
          <InfoRow label="注入次数">{evalData.injectionCount}</InfoRow>
          <InfoRow label="违规次数">{evalData.violationCount}</InfoRow>
          {evalData.injectionCount > 0 && (
            <InfoRow label="违规率">{((evalData.violationCount / evalData.injectionCount) * 100).toFixed(1)}%</InfoRow>
          )}
          {evalData.evaluatedAt && <InfoRow label="评估时间">{formatTs(evalData.evaluatedAt)}</InfoRow>}
        </div>
      ) : (
        <EvalPendingMetrics obsCount={obsCount} guardEventCount={guardEventCount} />
      )}
    </>
  );
}

/** Eval pending state: observation metrics + trigger progress. */
function EvalPendingMetrics({ obsCount, guardEventCount }: { obsCount: number; guardEventCount: number }) {
  const remaining = Math.max(0, EVAL_TRIGGER_THRESHOLD - guardEventCount);
  const progressPct = Math.min(100, (guardEventCount / EVAL_TRIGGER_THRESHOLD) * 100);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <InfoRow label="观测次数">
          <span className="font-mono">{obsCount}</span>
          <span className="ml-1 text-cafe-muted">次注入</span>
        </InfoRow>
        <InfoRow label="违规事件">
          <span className="font-mono">{guardEventCount}</span>
          <span className="ml-1 text-cafe-muted">次（7 天窗口）</span>
        </InfoRow>
        <InfoRow label="触发进度">
          <span className="font-mono">
            {guardEventCount}/{EVAL_TRIGGER_THRESHOLD}
          </span>
          <span className="ml-1 text-cafe-muted">事件</span>
        </InfoRow>
      </div>

      {/* Progress bar */}
      <div className="rounded-full h-1.5" style={{ backgroundColor: 'var(--console-elevated-bg)' }}>
        <div
          className="rounded-full h-1.5 transition-all"
          style={{
            width: `${progressPct}%`,
            backgroundColor:
              guardEventCount >= EVAL_TRIGGER_THRESHOLD ? 'var(--color-amber-500)' : 'var(--color-slate-400)',
          }}
        />
      </div>

      {/* Status explanation */}
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        {guardEventCount === 0
          ? '零违规事件 — 段运行正常，评估未触发'
          : remaining > 0
            ? `距离自动评估还差 ${remaining} 次违规事件`
            : '已达触发阈值，等待评估调度'}
      </SettingsText>

      <InfoRow label="评估方式">
        <span className="text-cafe-muted">fired-count（注入次数计数）</span>
      </InfoRow>
      <InfoRow label="上次评估">
        <span className="text-cafe-muted">从未评估</span>
      </InfoRow>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[80px] shrink-0 text-cafe-muted">{label}</span>
      <span className="text-cafe">{children}</span>
    </div>
  );
}
