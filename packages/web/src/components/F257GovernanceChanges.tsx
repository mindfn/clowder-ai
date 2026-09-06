'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffViewer } from './workspace/DiffViewer';

export function F257GovernanceChanges({ changes }: { changes: Array<Record<string, unknown>> }) {
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const close = useCallback(() => setSelected(null), []);

  if (changes.length === 0) return <p className="text-cafe-muted">本卡没有可执行动作。</p>;

  return (
    <>
      <ol className="space-y-2" data-testid="f257-governance-action-list">
        {changes.map((change, index) => (
          <li
            key={`${String(change.unitId ?? 'unit')}-${index}`}
            className="flex flex-col gap-2 rounded-lg border border-cafe-subtle/40 bg-cafe-muted/35 p-3 sm:flex-row sm:items-center"
            data-testid="f257-governance-change"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-cafe-accent/10 px-2 py-0.5 font-semibold text-cafe-accent">
                  {actionLabel(change.action)}
                </span>
                <span className="font-mono font-semibold">{String(change.unitId ?? '未知段')}</span>
              </div>
              {change.reason != null && <p className="mt-1 break-words text-cafe-muted">{String(change.reason)}</p>}
              <p className="mt-1 text-cafe-secondary">{changeImpactSummary(change)}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(change)}
              className="shrink-0 rounded-lg border border-cafe px-3 py-1.5 font-semibold text-cafe transition-colors hover:bg-cafe-surface"
              data-testid="f257-governance-open-diff"
            >
              查看左右差异
            </button>
          </li>
        ))}
      </ol>
      {selected && <GovernanceDiffDialog change={selected} onClose={close} />}
    </>
  );
}

function GovernanceDiffDialog({ change, onClose }: { change: Record<string, unknown>; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const comparisons = comparisonBlocks(change);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements the dialog close button and Escape key.
    <div
      role="presentation"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-2xl border border-cafe bg-[var(--console-card-bg)] shadow-2xl sm:max-h-[calc(100dvh-48px)]"
        data-testid="f257-governance-diff-dialog"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-cafe px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-cafe-muted">动作差异</p>
            <h2 id={titleId} className="mt-1 break-words text-lg font-bold text-cafe">
              {String(change.unitId ?? '未知段')} · {actionLabel(change.action)}
            </h2>
            {change.reason != null && (
              <p className="mt-1 break-words text-sm text-cafe-secondary">{String(change.reason)}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭动作差异"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-cafe-muted transition-colors hover:bg-[var(--console-modal-close-bg)] hover:text-cafe focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 sm:p-6">
          <div className="grid grid-cols-2 gap-3 text-xs font-semibold text-cafe-secondary">
            <span data-testid="f257-governance-before-heading">应用前</span>
            <span data-testid="f257-governance-after-heading">应用后</span>
          </div>
          {comparisons.map((comparison) => (
            <section key={comparison.id} className="space-y-2">
              <h3 className="text-sm font-semibold text-cafe">{comparison.label}</h3>
              <DiffViewer
                diff={fullContentDiff(
                  `${String(change.unitId ?? 'unit')}.${comparison.id}`,
                  comparison.before,
                  comparison.after,
                )}
                initialMode="split"
              />
            </section>
          ))}
          <div className="rounded-lg border border-cafe-subtle/40 bg-cafe-muted/35 p-3 text-sm">
            {changeImpactSummary(change)}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function comparisonBlocks(change: Record<string, unknown>): Array<{
  id: string;
  label: string;
  before: string;
  after: string;
}> {
  const action = String(change.action ?? '');
  const beforeContent = stringField(change, 'beforeContent') ?? '';
  const blocks: Array<{ id: string; label: string; before: string; after: string }> = [];

  if (action === 'add') {
    blocks.push({ id: 'content', label: '段内容', before: '', after: stringField(change, 'content') ?? '' });
  } else if (action === 'disable') {
    blocks.push({
      id: 'content',
      label: '段内容与启用状态',
      before: `当前启用并注入\n\n${beforeContent}`,
      after: '此段将不再注入',
    });
  } else if (action === 'enable') {
    blocks.push({
      id: 'content',
      label: '段内容与启用状态',
      before: `当前停用，不注入\n\n${beforeContent}`,
      after: `恢复启用并注入\n\n${beforeContent}`,
    });
  } else {
    const afterContent = firstStringField(change, ['proposedContent', 'targetContent']);
    if (afterContent !== undefined) {
      blocks.push({ id: 'content', label: '段内容', before: beforeContent, after: afterContent });
    }
  }

  if (change.proposedCondition !== undefined) {
    blocks.push({
      id: 'condition',
      label: '触发条件',
      before: formatCondition(change.beforeCondition),
      after: formatCondition(change.proposedCondition),
    });
  }

  if (blocks.length === 0) {
    blocks.push({ id: 'state', label: '状态', before: '当前状态', after: '应用提议后的状态' });
  }
  return blocks;
}

function changeImpactSummary(change: Record<string, unknown>): string {
  if (change.action === 'add') {
    const manifest = asRecord(change.manifest);
    const objectiveIds = asRecords(change.objectives).map((item) => String(item.objectiveId));
    return `新增到 ${objectiveIds.join('、') || '未知 Objective'}；注入位置 ${String(manifest.stage ?? '未知 stage')} / order ${String(manifest.order ?? '未知')}`;
  }
  if (change.action === 'disable' || change.action === 'enable') {
    const impact = asRecord(change.objectiveImpact);
    return `影响 Objective ${String(impact.objectiveId ?? '未知')}；动作后剩余成员段 ${String(impact.remainingMemberCount ?? '未知')} 个`;
  }
  if (change.action === 'rollback') {
    return `版本 v${String(change.sourceVersion ?? '未知')} → v${String(change.targetVersion ?? '未知')}`;
  }
  const contentChanged = stringField(change, 'proposedContent') !== undefined;
  const conditionChanged = change.proposedCondition !== undefined;
  if (contentChanged && conditionChanged) return '同时修改段内容与触发条件';
  if (conditionChanged) return '修改触发条件';
  return '修改段内容';
}

function actionLabel(action: unknown): string {
  if (action === 'modify') return '修改';
  if (action === 'disable') return '禁用';
  if (action === 'enable') return '启用';
  if (action === 'rollback') return '回退';
  if (action === 'add') return '新增';
  return '未知动作';
}

function formatCondition(value: unknown): string {
  if (value == null) return '无附加触发条件';
  const condition = asRecord(value);
  const conditionRef = String(condition.conditionRef ?? '未知条件');
  const params = condition.params === undefined ? '' : `\n参数：${JSON.stringify(condition.params, null, 2)}`;
  return `条件：${conditionRef}${params}`;
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
