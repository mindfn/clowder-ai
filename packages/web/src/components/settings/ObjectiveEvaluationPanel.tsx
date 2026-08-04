'use client';

import type {
  MetricResultValue,
  MetricTrigger,
  SegmentEvaluationResponse,
  SegmentMetricEvaluationView,
} from '@cat-cafe/shared';
import { SettingsBadge, SettingsText } from './primitives';

const formatTs = (value: number) => new Date(value).toLocaleString();

export function ObjectiveEvaluationPanel({ data }: { data: SegmentEvaluationResponse }) {
  if (data.objectives.length === 0) {
    return <EmptyCard text="该段尚未挂接 Objective；Tracing 仍会持续采集，但不会生成伪评估结果。" />;
  }
  return (
    <div className="space-y-4" data-testid="objective-evaluation-panel">
      {data.objectives.map((objective) => (
        <section
          key={`${objective.objectiveId}:${objective.unitRefs.map((ref) => ref.clauseId ?? ref.unitId).join(':')}`}
          className="rounded-2xl bg-[var(--console-panel-bg)] p-4"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <MetaRow label="归属">
              <span className="font-mono">{objective.objectiveId}</span>
              <span className="ml-2 text-cafe-muted">{objective.objectiveLabel}</span>
            </MetaRow>
            <MetaRow label="评估模型">
              <span className="font-mono">{objective.evaluationModelId}</span>
            </MetaRow>
          </div>
          <div className="mt-4 space-y-3">
            {objective.metrics.map((metric) => (
              <MetricCard key={metric.metricId} metric={metric} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MetricCard({ metric }: { metric: SegmentMetricEvaluationView }) {
  return (
    <article className="rounded-xl bg-[var(--console-card-bg)] p-3" data-metric-id={metric.metricId}>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsText as="h4" variant="sm" tone="default" className="font-semibold">
          {metric.label}
        </SettingsText>
        <SettingsBadge
          tone={metric.kind === 'counter' ? 'amber' : metric.kind === 'rate' ? 'blue' : 'slate'}
          size="xxs"
        >
          {kindLabel(metric.kind)}
        </SettingsBadge>
        <span className="ml-auto font-mono text-micro text-cafe-muted">{metric.metricId}</span>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <MetaRow label="触发条件">{triggerLabel(metric.trigger)}</MetaRow>
        <MetaRow label="评估方式">{evaluatorLabel(metric.evaluatorKind)}</MetaRow>
        <MetaRow label="当前数据">{collectionLabel(metric)}</MetaRow>
        <MetaRow label="采集窗口">
          {formatTs(metric.collection.window.start)} ~ {formatTs(metric.collection.window.end)}
        </MetaRow>
      </div>
      {metric.latestEvaluation ? (
        <div className="mt-3 rounded-lg bg-[var(--console-elevated-bg)] p-2">
          <MetaRow label="最近结果">{resultLabel(metric.latestEvaluation.result.value)}</MetaRow>
          <MetaRow label="评估时间">{formatTs(metric.latestEvaluation.result.evaluatedAt)}</MetaRow>
          <MetaRow label="评估窗口">
            {formatTs(metric.latestEvaluation.window.start)} ~ {formatTs(metric.latestEvaluation.window.end)}
          </MetaRow>
        </div>
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-3 italic">
          尚无评估结果；Tracing 与分类继续进行，不阻塞当前版本。
        </SettingsText>
      )}
    </article>
  );
}

function collectionLabel(metric: SegmentMetricEvaluationView): string {
  const { collection } = metric;
  if (metric.kind === 'counter') {
    return `反例 ${collection.counterexamples} 次；下一次触发 ${collection.pendingTowardTrigger}/${collection.required ?? '—'}`;
  }
  if (metric.kind === 'rate') {
    return `已分类 ${collection.classifiedTotal} 条（正例 ${collection.positive} / 反例 ${collection.counterexamples}）；下一批 ${collection.pendingTowardTrigger}/${collection.required ?? '—'}`;
  }
  return `正例 ${collection.positive} / 反例 ${collection.counterexamples} / 待语义分析 ${collection.candidates}`;
}

function triggerLabel(trigger: MetricTrigger): string {
  if (trigger.kind === 'distinct-counterexamples') return `不同 TraceEpisode 反例达到 ${trigger.threshold} 次`;
  if (trigger.kind === 'minimum-sample') return `窗口内有效样本达到 ${trigger.minimum} 条`;
  if (trigger.cadence === 'daily') return '每日后台评估';
  if (trigger.cadence === 'weekly') return '每周后台评估';
  return `每 ${trigger.cadence.slice(6, -1)} 天后台评估`;
}

function resultLabel(value: MetricResultValue): string {
  if (value.kind === 'counter') return `反例 ${value.count} 次，已达到阈值 ${value.threshold}`;
  if (value.kind === 'rate') {
    return `${value.numerator}/${value.denominator}（${(value.rate * 100).toFixed(1)}%）`;
  }
  if (value.kind === 'replay') return `通过 ${value.passed} / 失败 ${value.failed}`;
  return `${Object.entries(value.labels)
    .map(([label, count]) => `${label} ${count}`)
    .join('；')} — ${value.explanation}`;
}

function kindLabel(kind: SegmentMetricEvaluationView['kind']): string {
  if (kind === 'counter') return '次数阈值';
  if (kind === 'rate') return '比率';
  if (kind === 'semantic') return '语义评估';
  return '回放评估';
}

function evaluatorLabel(kind: SegmentMetricEvaluationView['evaluatorKind']): string {
  if (kind === 'code') return '结构化规则';
  if (kind === 'llm') return '后台 LLM 语义分析';
  return '固定回放样例';
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-[72px] shrink-0 text-cafe-muted">{label}</span>
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
