'use client';

import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function UserMentionDetails({ request }: { request: NonNullable<UnifiedAttentionItemV1['userMention']> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function resolve() {
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/concierge/work/mentions/${encodeURIComponent(request.threadId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedMessageId: request.messageId, expectedRevision: request.expectedRevision }),
      });
      if (!response.ok) {
        setError(response.status === 409 ? '这条对话有了新请求，请重新读取后处理。' : '未能标记处理，请重试。');
        if (response.status === 409) window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
        return;
      }
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch {
      setError('未能标记处理，请重试。');
    } finally {
      setPending(false);
    }
  }
  async function restore() {
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch('/api/concierge/work/mentions/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: request.threadId,
          messageId: request.messageId,
          expectedRevision: request.expectedRevision,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '这条对话已有新请求或后续变化，请重新读取。' : '未能放回待办，请重试。',
        );
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '未能放回待办，请重试。');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 whitespace-pre-wrap break-words text-sm" data-testid="mailbox-mention-content">
        {request.content}
      </p>
      {request.handled ? (
        <button
          type="button"
          disabled={pending || request.expectedRevision === undefined}
          onClick={() => void restore()}
          className="shell-nav-row shell-focusable self-start rounded-lg px-3 py-1.5 text-sm"
          data-testid="mailbox-mention-restore"
        >
          {pending ? '正在放回…' : '放回待办'}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => void resolve()}
          className="shell-nav-row shell-focusable self-start rounded-lg px-3 py-1.5 text-sm"
          data-testid="mailbox-mention-resolve"
        >
          {pending ? '正在标记…' : '已处理'}
        </button>
      )}
      {error ? (
        <p role="alert" className="m-0 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
