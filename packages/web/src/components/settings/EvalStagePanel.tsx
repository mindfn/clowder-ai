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

import type { GuardMetric } from '@cat-cafe/shared';
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
  /** Per-guard event counts for this epoch's time window, sorted by count desc. */
  guardMetrics: GuardMetric[];
}

// ── Constants ────────────────────────────────────────────────────

/** Eval trigger threshold: ≥3 guard events within 7-day window. */
const EVAL_TRIGGER_THRESHOLD = 3;

const formatTs = (ms: number) => new Date(ms).toLocaleString();

// ── Components ───────────────────────────────────────────────────

export function EvalStagePanel({ version, eval: evalData, tracing, guardMetrics }: EvalDetailProps) {
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
        <EvalPendingMetrics obsCount={obsCount} guardMetrics={guardMetrics} />
      )}
    </>
  );
}

/** Eval pending state: per-guard metrics + trigger progress (P1-1 fix). */
function EvalPendingMetrics({ obsCount, guardMetrics }: { obsCount: number; guardMetrics: GuardMetric[] }) {
  const totalEvents = guardMetrics.reduce((s, g) => s + g.count, 0);
  const maxCount = guardMetrics.length > 0 ? guardMetrics[0].count : 0;
  const remaining = Math.max(0, EVAL_TRIGGER_THRESHOLD - maxCount);
  const progressPct = Math.min(100, (maxCount / EVAL_TRIGGER_THRESHOLD) * 100);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <InfoRow label="观测次数">
          <span className="font-mono">{obsCount}</span>
          <span className="ml-1 text-cafe-muted">次注入</span>
        </InfoRow>
        <InfoRow label="违规事件">
          <span className="font-mono">{totalEvents}</span>
          <span className="ml-1 text-cafe-muted">次（本版本窗口）</span>
        </InfoRow>
        <InfoRow label="触发进度">
          <span className="font-mono">
            {maxCount}/{EVAL_TRIGGER_THRESHOLD}
          </span>
          <span className="ml-1 text-cafe-muted">（单 guard 最高）</span>
        </InfoRow>
      </div>

      {/* Progress bar — tracks single-guard max toward threshold */}
      <div className="rounded-full h-1.5" style={{ backgroundColor: 'var(--console-elevated-bg)' }}>
        <div
          className="rounded-full h-1.5 transition-all"
          style={{
            width: `${progressPct}%`,
            backgroundColor: maxCount >= EVAL_TRIGGER_THRESHOLD ? 'var(--color-amber-500)' : 'var(--color-slate-400)',
          }}
        />
      </div>

      {/* Per-guard breakdown */}
      {guardMetrics.length > 0 && (
        <div className="space-y-0.5">
          <SettingsText as="p" variant="xs" tone="muted" className="font-semibold">
            Guard 分布
          </SettingsText>
          {guardMetrics.map((g) => (
            <div key={g.guardId} className="flex items-center gap-2 text-xs">
              <span className="w-[120px] shrink-0 truncate font-mono text-cafe-muted">{g.guardId}</span>
              <span className="font-mono">
                {g.count}/{EVAL_TRIGGER_THRESHOLD}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Status explanation */}
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        {totalEvents === 0
          ? '零违规事件 — 段运行正常，评估未触发'
          : remaining > 0
            ? `距离自动评估还差 ${remaining} 次违规（同一 guard）`
            : '已达触发阈值，等待评估调度'}
      </SettingsText>

      <InfoRow label="评估方式">
        <span className="text-cafe-muted">{obsCount > 0 ? 'fired-count（注入次数计数）' : '无注入数据'}</span>
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
