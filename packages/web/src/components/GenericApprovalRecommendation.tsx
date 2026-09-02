import type { ApprovalItem } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { CriticalText } from './content-overflow';
import { DiffViewer } from './workspace/DiffViewer';
import { openInvocationTrajectory } from './workspace/trajectory/trajectory-navigation';

export function GenericApprovalRecommendation({
  item,
  f221TasteEvidence,
  f225HandoffDetails,
  f193TargetThreadId,
  sourceThreadTitle,
  targetThreadTitle,
  resolveCatName,
}: {
  item: ApprovalItem;
  f221TasteEvidence?: string;
  f225HandoffDetails?: string;
  f193TargetThreadId: string;
  sourceThreadTitle: string;
  targetThreadTitle: string | null;
  resolveCatName: (catId: string) => string;
}) {
  return (
    <div className="space-y-2 text-micro">
      {item.sourceFeatureId === 'F128' && item.detail.reason != null && (
        <CriticalText summary="审批理由" details={String(item.detail.reason)} tone="warning" />
      )}
      {item.sourceFeatureId === 'F225' && f225HandoffDetails && (
        <CriticalText summary="交接记录" details={f225HandoffDetails} tone="info" />
      )}
      {item.sourceFeatureId === 'F221' && <TasteRecommendation item={item} evidence={f221TasteEvidence} />}
      {item.sourceFeatureId === 'F193' && (
        <DispatchRecommendation
          item={item}
          sourceThreadTitle={sourceThreadTitle}
          targetThreadTitle={targetThreadTitle}
          targetThreadId={f193TargetThreadId}
          resolveCatName={resolveCatName}
        />
      )}
      {item.sourceFeatureId === 'F257' && <HarnessGovernanceRecommendation item={item} />}
      {item.sourceFeatureId === 'F260' && <EntityRecommendation item={item} />}
    </div>
  );
}

function HarnessGovernanceRecommendation({ item }: { item: ApprovalItem }) {
  const header = asRecord(item.detail.header);
  const conclusions = asRecords(item.detail.conclusions);
  const history = asRecords(item.detail.history);
  const changes = asRecords(item.detail.changes);
  const evidenceRefs = Array.isArray(item.detail.evidenceRefs) ? item.detail.evidenceRefs.map(String) : [];
  const rejectReasons = Array.isArray(item.detail.rejectReasons) ? item.detail.rejectReasons.map(String) : [];
  return (
    <div className="space-y-2" data-testid="f257-harness-governance-recommendation">
      <GovernanceSection title="1 · 周期与版本" testId="f257-governance-header">
        <GovernanceHeader header={header} />
      </GovernanceSection>

      <GovernanceSection title="2 · 评估结论与历史" testId="f257-governance-conclusions">
        {conclusions.map((metric, index) => (
          <div key={`${String(metric.id ?? 'metric')}-${index}`} className="rounded bg-cafe-muted/60 px-2 py-1">
            <span className="font-medium">{String(metric.id ?? `指标 ${index + 1}`)}</span>
            <span className="ml-2 break-words opacity-75">{formatValue(metric.conclusion)}</span>
          </div>
        ))}
        {item.detail.governanceReason != null && <p>治理判断：{String(item.detail.governanceReason)}</p>}
        <details>
          <summary className="cursor-pointer opacity-70">历史周期（{history.length}）</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-cafe-muted p-2 text-micro">
            {JSON.stringify(history, null, 2)}
          </pre>
        </details>
      </GovernanceSection>

      <GovernanceSection title="3 · 逐段内容变更" testId="f257-governance-changes">
        {changes.map((change, index) => (
          <GovernanceChangeView key={`${String(change.unitId ?? 'unit')}-${index}`} change={change} />
        ))}
      </GovernanceSection>

      <GovernanceSection title={`4 · 证据引用（${evidenceRefs.length}）`} testId="f257-governance-evidence">
        {evidenceRefs.length > 0 ? (
          <ul className="max-h-32 space-y-1 overflow-auto font-mono text-micro">
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
        ) : (
          <p className="opacity-60">本次结论未附证据引用。</p>
        )}
      </GovernanceSection>

      <GovernanceSection title="5 · 决策与谱系" testId="f257-governance-lineage">
        <p>提案轮次：{String(item.detail.cardOrdinal ?? 1)}</p>
        <p>批准会应用上述 overlay/目录动作并进入下一周期；跳过会保留当前版本并进入下一周期。</p>
        <p>拒绝必须填写理由，系统将对同一窗口重新评估并生成新卡。</p>
        {rejectReasons.length > 0 && <p>上次拒绝理由：{rejectReasons.join('；')}</p>}
        {item.detail.decisionReason != null && <p>本卡处理理由：{String(item.detail.decisionReason)}</p>}
      </GovernanceSection>
    </div>
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
  const after = firstStringField(change, ['proposedContent', 'targetContent', 'content']);
  const hasContentChange = before !== undefined || after !== undefined;
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
      {change.action === 'add' && (
        <p>
          挂靠 Objective：
          {asRecords(change.objectives)
            .map((item) => String(item.objectiveId))
            .join(', ')}
        </p>
      )}
    </article>
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

function TasteRecommendation({ item, evidence }: { item: ApprovalItem; evidence?: string }) {
  return (
    <div className="space-y-1">
      {evidence && <CriticalText summary="品味提案依据" details={evidence} tone="info" />}
      <div className="flex flex-wrap items-center gap-1.5">
        {item.detail.dimension != null && <DetailChip>{String(item.detail.dimension)}</DetailChip>}
        {item.detail.privacy === 'sensitive' && (
          <span className="rounded-md bg-[var(--semantic-warning)] px-1.5 py-0.5 font-medium text-[var(--cafe-accent-foreground)]">
            sensitive
          </span>
        )}
        {Array.isArray(item.detail.tags) &&
          item.detail.tags.map((tag) => <DetailChip key={String(tag)}>{String(tag)}</DetailChip>)}
      </div>
    </div>
  );
}

function DispatchRecommendation({
  item,
  sourceThreadTitle,
  targetThreadTitle,
  targetThreadId,
  resolveCatName,
}: {
  item: ApprovalItem;
  sourceThreadTitle: string;
  targetThreadTitle: string | null;
  targetThreadId: string;
  resolveCatName: (catId: string) => string;
}) {
  const targetCats = Array.isArray(item.detail.targetCats)
    ? item.detail.targetCats
        .map((catId) => (typeof catId === 'string' ? resolveCatName(catId) : String(catId)))
        .join(', ')
    : String(item.detail.targetCats);

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 opacity-60">从：</span>
        <span className="flex-1 truncate">{sourceThreadTitle}</span>
        <span className="shrink-0 opacity-60">→</span>
        <span className="flex-1 truncate">{targetThreadTitle ?? targetThreadId}</span>
      </div>
      {item.detail.content != null && (
        <CriticalText summary="派发内容" details={String(item.detail.content)} tone="info" />
      )}
      {item.detail.targetCats != null && <p>交给： {targetCats}</p>}
    </div>
  );
}

function EntityRecommendation({ item }: { item: ApprovalItem }) {
  return (
    <div className="space-y-1">
      <p data-testid="entity-proposal-identity">
        提案 {item.proposalId} · 目标实体 {String(item.detail.entityId ?? '未指定')}
      </p>
      {item.detail.canonicalName != null && (
        <p className="font-medium">
          {String(item.detail.canonicalName)} ({String(item.detail.entityType ?? 'entity')})
        </p>
      )}
      {Array.isArray(item.detail.aliases) && item.detail.aliases.length > 0 && (
        <p className="truncate">别名: {item.detail.aliases.join(', ')}</p>
      )}
      {item.detail.rationale != null && (
        <CriticalText summary="登记理由" details={String(item.detail.rationale)} tone="info" />
      )}
    </div>
  );
}

function DetailChip({ children }: { children: string }) {
  return <span className="rounded bg-cafe-muted px-1 py-0.5 text-micro">{children}</span>;
}
