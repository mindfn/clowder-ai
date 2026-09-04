'use client';

import type { SegmentTracingEvaluationView } from '@cat-cafe/shared';
import { useState } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentReplayPanel } from './SegmentReplayPanel';

export interface TraceTheaterObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

export function SegmentTraceTheater({
  segmentId,
  observations,
  window,
  readiness,
  loading,
  error,
  capped,
}: {
  segmentId: string;
  observations: TraceTheaterObservation[];
  window: { startMs: number; endMs: number } | null;
  readiness: SegmentTracingEvaluationView | null;
  loading?: boolean;
  error?: string | null;
  capped?: boolean;
}) {
  const [selected, setSelected] = useState<{
    threadId: string;
    turnId: string;
    catId: string;
    pipelineStatus: string;
  } | null>(null);
  const trigger = readiness?.trigger;
  const cycleStart = cycleStartMs(trigger, window);
  return (
    <div className="space-y-3" data-testid="segment-trace-theater">
      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <MetaRow label="触发条件">
            {loading ? '加载中…' : trigger ? <TriggerRules trigger={trigger} /> : '当前 Unit 尚无评估触发配置'}
          </MetaRow>
          <MetaRow label="周期起点">{cycleStart ? new Date(cycleStart).toLocaleString() : '窗口未知'}</MetaRow>
        </div>
        {error && (
          <SettingsText as="p" variant="xs" tone="red" className="mt-2">
            {error}
          </SettingsText>
        )}
      </section>

      <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          结构化反例 Tracing
        </SettingsText>
        {!loading && (readiness?.structuredCounterexamples.length ?? 0) === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            周期内暂无明确反例；周期内 Tracing 仍持续累计。
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {readiness?.structuredCounterexamples.map((counterexample) => (
              <button
                type="button"
                key={counterexample.annotationId}
                onClick={() => setSelected({ ...counterexample, pipelineStatus: 'structured' })}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-card-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(counterexample.createdAt).toLocaleString()}
                </span>
                <SettingsBadge tone="amber" size="xxs">
                  明确反例
                </SettingsBadge>
                <span className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">
                  {counterexample.rationale ?? counterexample.incidentKey}
                </span>
                <span className="shrink-0 text-xs text-cafe-muted" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <details className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <summary className="cursor-pointer text-xs font-semibold text-cafe-secondary">
          生命线查询窗内本段 Tracing 明细
        </summary>
        <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
          点击记录查看完整现场
        </SettingsText>
        {observations.length === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前生命线查询窗内本段暂无 Tracing 记录
          </SettingsText>
        ) : (
          <div className="mt-2 space-y-1.5">
            {observations.map((observation) => (
              <button
                type="button"
                key={`${observation.threadId}:${observation.turnId}`}
                onClick={() => setSelected(observation)}
                className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
              >
                <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                  {new Date(observation.timestamp).toLocaleString()}
                </span>
                <SettingsBadge tone={observation.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
                  {observation.pipelineStatus === 'fired' ? '已注入' : '已观测'}
                </SettingsBadge>
                <span className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">@{observation.catId}</span>
                <span className="shrink-0 text-micro text-cafe-muted">{observation.charCount} chars</span>
                <span className="shrink-0 text-xs text-cafe-muted" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}
        {capped && (
          <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
            当前仅展示最近 100 场；累计记录仍为完整窗口计数。
          </SettingsText>
        )}
      </details>
      {selected && (
        <SegmentReplayPanel
          segmentId={segmentId}
          threadId={selected.threadId}
          turnId={selected.turnId}
          catId={selected.catId}
          pipelineStatus={selected.pipelineStatus}
          isOpen
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * Trigger rules are Objective-cycle counts. The detail list below remains a
 * segment-scoped view of the lifeline query window; their labels must not imply
 * that the two coordinates or denominators are interchangeable.
 */
function TriggerRules({ trigger }: { trigger: SegmentTracingEvaluationView['trigger'] }) {
  const objective = trigger.objective;
  return (
    <div className="space-y-2">
      <div>满足任一路即触发 Objective 评估</div>
      <div className="rounded-lg bg-[var(--console-card-bg)] p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono">{objective.objectiveId}</span>
          <SettingsBadge tone={objective.evalStatus === 'stalled' ? 'red' : 'slate'} size="xxs">
            {objective.evalStatus}
          </SettingsBadge>
          <SettingsBadge tone={objective.lifecycle === 'dormant' ? 'amber' : 'slate'} size="xxs">
            {objective.lifecycle}
          </SettingsBadge>
          {objective.triggeredBy.map((route) => (
            <SettingsBadge key={route} tone="blue" size="xxs">
              {routeLabel(route)} 已触发
            </SettingsBadge>
          ))}
        </div>
        {objective.health === 'zero-trace-fault' && (
          <SettingsText as="div" variant="xs" tone="red" className="mt-1 font-medium">
            采集故障：owner 线性池在本周期内没有 Tracing
          </SettingsText>
        )}
        <div className="mt-1 text-cafe-muted">
          · 周期内累计 Tracing（Objective）{objective.cumulative.count}/{objective.cumulative.threshold} 条
        </div>
        <div className="text-cafe-muted">
          · 周期内反例 {objective.counterexamples.count}/{objective.counterexamples.threshold} 条
        </div>
        <div className="text-cafe-muted">
          · 距周期起点 {formatDuration(objective.cadence.elapsedMs)}/{formatDuration(objective.cadence.thresholdMs)}
          {!objective.cadence.eligible ? '（至少需 1 条累计 Tracing）' : ''}
        </div>
        <div className="text-cafe-muted">· 触发策略已调整 {objective.policyChangeCount} 次</div>
      </div>
    </div>
  );
}

/** Cycle start comes from the segment's sole Objective; falls back to the version window. */
function cycleStartMs(
  trigger: SegmentTracingEvaluationView['trigger'] | undefined,
  window: { startMs: number; endMs: number } | null,
): number | null {
  if (trigger?.objective.cycleStartMs && trigger.objective.cycleStartMs > 0) return trigger.objective.cycleStartMs;
  return window?.startMs ?? null;
}

function routeLabel(route: SegmentTracingEvaluationView['trigger']['objective']['triggeredBy'][number]) {
  return { cumulative: '累计', counterexamples: '反例', cadence: '周期' }[route];
}

function formatDuration(value: number): string {
  const days = value / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${days.toFixed(days >= 10 ? 0 : 1)} 天`;
  const hours = value / (60 * 60 * 1000);
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} 小时`;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[72px] shrink-0 text-cafe-muted">{label}</span>
      <span className="min-w-0 text-cafe-secondary">{children}</span>
    </div>
  );
}
