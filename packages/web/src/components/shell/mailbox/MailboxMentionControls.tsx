import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell-copy';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { MentionHandlingConfirmation } from './MentionHandlingConfirmation';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';

type Snapshot = {
  requests: { threadId: string; messageId: string; expectedRevision: number }[];
  period: 'today' | 'week' | 'earlier' | 'all';
  counts: { week: number; earlier: number };
};
const BUTTON = 'shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs disabled:opacity-50';

/** The selected filter and explicit all option use the same owner-scoped snapshot endpoint. */
export function MailboxMentionControls({
  read,
  view,
}: {
  read: UnifiedAttentionReadV1 | null;
  view: UnifiedAttentionView;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = read?.mentionCounts;
  const period = read?.mentionPeriod === 'recent' ? 'week' : (read?.mentionPeriod ?? 'week');
  async function prepare(scope: Snapshot['period']) {
    if (!read) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/concierge/work/mentions/handling-preview?period=${scope}`);
      if (!response.ok) throw new Error('无法读取待处理请求，请重试。');
      const result = await response.json();
      if (
        result.ownerUserId !== read.identity.ownerUserId ||
        result.period !== scope ||
        !Array.isArray(result.requests)
      )
        throw new Error('无法确认请求归属与范围。');
      if (
        !result.requests.every(
          (r: Snapshot['requests'][number]) =>
            r &&
            typeof r.threadId === 'string' &&
            typeof r.messageId === 'string' &&
            Number.isSafeInteger(r.expectedRevision) &&
            r.expectedRevision >= 0,
        )
      )
        throw new Error('无法读取请求版本。');
      if (![result.counts?.week, result.counts?.earlier].every((n) => Number.isSafeInteger(n) && n >= 0))
        throw new Error('无法确认请求数量。');
      if (!result.requests.length) setNotice('没有符合条件的 @你 请求。');
      else setSnapshot({ requests: result.requests, period: scope, counts: result.counts });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '读取失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const response = await apiFetch('/api/concierge/work/mentions/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: snapshot.requests }),
      });
      if (!response.ok)
        throw new Error(response.status === 409 ? '请求有变化，本次没有处理。请重新确认。' : '未能处理，请重试。');
      setNotice(null);
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '未能处理，请重试。');
    } finally {
      setSnapshot(null);
      setBusy(false);
    }
  }
  if (!read || period === 'handled') return null;
  const count = counts?.[period] ?? 0;
  const allCount = (counts?.week ?? 0) + (counts?.earlier ?? 0);
  return (
    <div className="mb-3 flex flex-col gap-2 text-xs" data-testid="mailbox-mention-controls">
      <div role="group" className="flex flex-wrap gap-1" aria-label="请求时间筛选">
        {(['today', 'week', 'earlier'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={BUTTON}
            aria-pressed={period === value}
            disabled={busy}
            onClick={() => view.setMentionPeriod?.(value)}
            style={{ background: period === value ? 'var(--shell-selected)' : undefined }}
          >
            {value === 'today' ? '今天' : value === 'week' ? '这周' : `更早 · ${counts?.earlier ?? 0}`}
          </button>
        ))}
      </div>
      {period === 'week' ? (
        <p className="m-0" style={{ color: 'var(--shell-muted)' }}>
          最近七天，包含今天。
        </p>
      ) : null}
      {allCount > 0 ? (
        <div className="flex flex-wrap gap-2">
          {count > 0 ? (
            <button
              className={BUTTON}
              type="button"
              disabled={busy || !count}
              onClick={() => void prepare(period)}
              data-testid="mailbox-mentions-handle-selected"
            >
              把这 {count} 件标为已处理
            </button>
          ) : null}
          <button
            className={BUTTON}
            type="button"
            disabled={busy || !allCount}
            onClick={() => void prepare('all')}
            data-testid="mailbox-mentions-handle-all"
          >
            {t.handleAll(allCount)}
          </button>
        </div>
      ) : null}
      {period === 'earlier' ? (
        <p className="m-0" style={{ color: 'var(--shell-muted)' }}>
          更早的 @你 请求，仅供回看，不计入角标。
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="m-0">
          {notice}
        </p>
      ) : null}
      {snapshot ? (
        <MentionHandlingConfirmation
          count={snapshot.requests.length}
          scope={snapshot.period}
          counts={snapshot.counts}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setSnapshot(null)}
        />
      ) : null}
    </div>
  );
}
