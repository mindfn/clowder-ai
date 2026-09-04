import type { ApprovalHubItem } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { DiffViewer } from './workspace/DiffViewer';
import { openInvocationTrajectory } from './workspace/trajectory/trajectory-navigation';

export function F257GovernanceRecommendation({ item }: { item: ApprovalHubItem }) {
  const header = asRecord(item.detail.header);
  const conclusions = asRecords(item.detail.conclusions);
  const metricVisuals = asRecords(item.detail.metricVisuals);
  const history = asRecords(item.detail.history);
  const changes = asRecords(item.detail.changes);
  const evidenceRefs = Array.isArray(item.detail.evidenceRefs) ? item.detail.evidenceRefs.map(String) : [];
  const rejectReasons = Array.isArray(item.detail.rejectReasons) ? item.detail.rejectReasons.map(String) : [];
  return (
    <div className="space-y-2" data-testid="f257-harness-governance-recommendation">
      <div className="space-y-1 rounded-md border border-cafe-subtle/30 p-2" data-testid="f257-governance-header">
        <GovernanceHeader header={header} />
      </div>

      <GovernanceSection title="1 · 指标数据" testId="f257-governance-metrics">
        {metricVisuals.map((metric) => (
          <MetricVisual key={String(metric.id)} metric={metric} />
        ))}
      </GovernanceSection>

      <GovernanceSection title="2 · 指标变化" testId="f257-governance-deltas">
        {item.detail.hasComparisonBaseline === true ? (
          metricVisuals.map((metric) => <MetricDelta key={String(metric.id)} metric={metric} />)
        ) : (
          <p data-testid="f257-governance-first-cycle">
            {item.detail.isFirstCycle === true
              ? '首轮评估，暂无可比较的历史基线。'
              : '历史周期中没有相同指标的可比较基线。'}
          </p>
        )}
      </GovernanceSection>

      <GovernanceSection title="3 · 结论摘要" testId="f257-governance-conclusions">
        {conclusions.map((metric, index) => (
          <div key={`${String(metric.id ?? 'metric')}-${index}`} className="rounded bg-cafe-muted/60 px-2 py-1">
            <span className="font-medium">{String(metric.id ?? `指标 ${index + 1}`)}</span>
            <span className="ml-2 break-words opacity-75">{formatValue(metric.conclusion)}</span>
          </div>
        ))}
        {item.detail.governanceReason != null && <p>治理判断：{String(item.detail.governanceReason)}</p>}
        {evidenceRefs.length > 0 ? (
          <details>
            <summary className="cursor-pointer opacity-70">证据引用（{evidenceRefs.length}）</summary>
            <ul className="mt-1 max-h-32 space-y-1 overflow-auto font-mono text-micro">
              {evidenceRefs.map((reference) => (
                <li key={reference}>
                  <button
                    type="button"
                    className="break-all text-left underline underline-offset-2"
                    onClick={() => openInvocationTrajectory({ invocationId: reference })}
                    data-testid="f257-governance-evidence-link"
                  >
                    {reference}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="opacity-60">本次结论未附证据引用。</p>
        )}
        <details>
          <summary className="cursor-pointer opacity-70">历史周期（{history.length}）</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-cafe-muted p-2 text-micro">
            {JSON.stringify(history, null, 2)}
          </pre>
        </details>
      </GovernanceSection>

      <GovernanceSection title="4 · 动作与逐段差异" testId="f257-governance-changes">
        {changes.map((change, index) => (
          <GovernanceChangeView key={`${String(change.unitId ?? 'unit')}-${index}`} change={change} />
        ))}
      </GovernanceSection>

      <GovernanceSection title="5 · 人工决策" testId="f257-governance-lineage">
        <p>提案轮次：{String(item.detail.cardOrdinal ?? 1)}</p>
        <p>批准会原子接受整张卡的动作列表，不可挑批；组合不合适请拒绝并说明理由。</p>
        <p>跳过会保留当前版本并进入下一周期。</p>
        <p>拒绝必须填写理由，系统将对同一窗口重新评估并生成新卡。</p>
        {rejectReasons.length > 0 && <p>上次拒绝理由：{rejectReasons.join('；')}</p>}
        {item.detail.decisionReason != null && <p>本卡处理理由：{String(item.detail.decisionReason)}</p>}
      </GovernanceSection>
    </div>
  );
}

function MetricVisual({ metric }: { metric: Record<string, unknown> }) {
  const current = numberField(metric, 'currentValue') ?? 0;
  const previous = numberField(metric, 'previousValue');
  const maximum = Math.max(1, Math.abs(current), Math.abs(previous ?? 0));
  return (
    <div className="space-y-1 rounded bg-cafe-muted/60 px-2 py-1" data-testid="f257-governance-metric-visual">
      <div className="flex justify-between gap-2">
        <span className="font-medium">{String(metric.id ?? '未知指标')}</span>
        <span className="font-mono">{formatNumber(current)}</span>
      </div>
      <progress
        className="h-2 w-full"
        max={maximum}
        value={Math.abs(current)}
        aria-label={`${String(metric.id)} 当前值`}
      />
    </div>
  );
}

function MetricDelta({ metric }: { metric: Record<string, unknown> }) {
  const previous = numberField(metric, 'previousValue');
  const current = numberField(metric, 'currentValue');
  const delta = numberField(metric, 'delta');
  if (previous === null || current === null || delta === null) return null;
  return (
    <p data-testid="f257-governance-metric-delta">
      {String(metric.id ?? '未知指标')}：{formatNumber(previous)} → {formatNumber(current)}（{delta >= 0 ? '+' : ''}
      {formatNumber(delta)}）
    </p>
  );
}

function GovernanceHeader({ header }: { header: Record<string, unknown> }) {
  const objective = asRecord(header.objective);
  const triggerCounts = asRecord(header.triggerCounts);
  const cumulative = asRecord(triggerCounts.cumulative);
  const counterexamples = asRecord(triggerCounts.counterexamples);
  const windows = asRecords(header.windows);
  const triggeredBy = Array.isArray(header.triggeredBy) ? header.triggeredBy.map(String) : [];
  return (
    <>
      <p>
        Objective：<span className="font-medium">{String(objective.label ?? header.objectiveId ?? '未知')}</span>
        {objective.id != null && <span className="opacity-60">（{String(objective.id)}）</span>}
      </p>
      <p>
        当前版本：{String(header.currentVersion ?? '未知')} · 建议：{String(header.decision ?? '未知')}
      </p>
      <p>本周期窗口：{windows.map(formatWindow).join('；') || '未知'}</p>
      <p>触发原因：{triggeredBy.join(' / ') || '未知'}</p>
      <p>
        周期内累计 {String(cumulative.count ?? '未知')}/{String(cumulative.threshold ?? '未知')} · 周期内反例{' '}
        {String(counterexamples.count ?? '未知')}/{String(counterexamples.threshold ?? '未知')}
      </p>
    </>
  );
}

function GovernanceSection({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="space-y-1 rounded-md border border-cafe-subtle/30 p-2" data-testid={testId}>
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function GovernanceChangeView({ change }: { change: Record<string, unknown> }) {
  const before = stringField(change, 'beforeContent');
  const after =
    change.action === 'disable'
      ? '此段将不再注入'
      : firstStringField(change, ['proposedContent', 'targetContent', 'content']);
  const hasContentChange = before !== undefined || after !== undefined;
  const beforeCondition = change.beforeCondition;
  const proposedCondition = change.proposedCondition;
  return (
    <article className="space-y-1 rounded bg-cafe-muted/60 p-2" data-testid="f257-governance-change">
      <p className="font-medium">
        {String(change.unitId ?? '未知段')} · {String(change.action ?? '未知动作')}
      </p>
      {change.reason != null && <p className="opacity-70">{String(change.reason)}</p>}
      {hasContentChange ? (
        <GovernanceContentChange unitId={String(change.unitId ?? 'unit')} before={before} after={after} />
      ) : (
        <p>启用状态：{formatEnablementChange(change)}</p>
      )}
      <GovernanceChangeSupplement change={change} />
      {proposedCondition !== undefined && (
        <GovernanceContentChange
          unitId={`${String(change.unitId ?? 'unit')}.condition`}
          before={JSON.stringify(beforeCondition ?? null, null, 2)}
          after={JSON.stringify(proposedCondition ?? null, null, 2)}
        />
      )}
    </article>
  );
}

function GovernanceChangeSupplement({ change }: { change: Record<string, unknown> }) {
  if (change.action === 'add') {
    const manifest = asRecord(change.manifest);
    const objectiveIds = asRecords(change.objectives).map((item) => String(item.objectiveId));
    return (
      <>
        <p>挂靠 Objective：{objectiveIds.join(', ')}</p>
        <p>
          注入位置：{String(manifest.stage ?? '未知 stage')} / order {String(manifest.order ?? '未知')}
        </p>
      </>
    );
  }
  if (change.action !== 'disable') return null;
  const impact = asRecord(change.objectiveImpact);
  return (
    <p>
      影响面：Objective {String(impact.objectiveId ?? '未知')}；禁用后剩余成员段{' '}
      {String(impact.remainingMemberCount ?? '未知')} 个
    </p>
  );
}

function GovernanceContentChange({ unitId, before, after }: { unitId: string; before?: string; after?: string }) {
  const beforeText = before ?? '';
  const afterText = after ?? '';
  const lineCount = beforeText.split('\n').length + afterText.split('\n').length;
  return (
    <details open={lineCount <= 24}>
      <summary className="cursor-pointer">逐行 diff（可展开全文）</summary>
      <div className="mt-1 max-h-96 overflow-auto">
        <DiffViewer diff={fullContentDiff(unitId, beforeText, afterText)} compact />
      </div>
    </details>
  );
}

function fullContentDiff(unitId: string, before: string, after: string): string {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  return [
    `diff --git a/${unitId}.md b/${unitId}.md`,
    `--- a/${unitId}.md`,
    `+++ b/${unitId}.md`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined;
}

function firstStringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = stringField(value, field);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function formatEnablementChange(change: Record<string, unknown>): string {
  const before = change.beforeEnabled === true ? 'true' : change.beforeEnabled === false ? 'false' : '未知';
  const after = change.action === 'enable' ? 'true' : 'false';
  return `${before} → ${after}`;
}

function formatWindow(window: Record<string, unknown>): string {
  const start = typeof window.start === 'number' ? new Date(window.start).toISOString() : '未知';
  const end = typeof window.end === 'number' ? new Date(window.end).toISOString() : '未知';
  return `${start} → ${end}`;
}

function numberField(value: Record<string, unknown>, field: string): number | null {
  return typeof value[field] === 'number' && Number.isFinite(value[field]) ? (value[field] as number) : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
