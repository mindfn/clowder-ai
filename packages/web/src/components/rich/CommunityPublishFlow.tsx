'use client';

import { useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from './CommunityIssuePreviewCard';

type CommunityPublishStatus = 'confirmed' | 'creating_draft' | 'draft_created';
interface CommunityPublishFlowProps {
  issueId: string;
  title: string;
  bodyMarkdown: string;
  status: CommunityPublishStatus;
  onStatusChange: (status: CommunityPublishStatus) => void;
}
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts';

/** Transfers the content explicitly selected by the owner to the plugin's ordinary draft action. */
export function CommunityPublishFlow({
  issueId,
  title,
  bodyMarkdown,
  status,
  onStatusChange,
}: CommunityPublishFlowProps) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(`feedback:${issueId}`);
  const createDraft = async () => {
    onStatusChange('creating_draft');
    setError(null);
    try {
      const configResponse = await apiFetch(`${endpoint}/config`);
      if (!configResponse.ok) throw new Error('GitHub 插件暂不可用，请检查插件设置。');
      const config = await configResponse.json();
      if (!config.defaultRepo) throw new Error('请先在 GitHub 插件中配置发布仓库。');
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: requestId.current, repo: config.defaultRepo, title, bodyMarkdown }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `创建草稿失败 (${response.status})`);
      if (!result.data?.id || !result.data.title) throw new Error('插件未返回草稿。');
      setDraftId(result.data.id);
      onStatusChange('draft_created');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建草稿失败');
      onStatusChange('confirmed');
    }
  };
  if (status === 'creating_draft') return <div className="mt-2 text-xs text-cafe-muted">正在创建草稿…</div>;
  if (draftId)
    return (
      <CommunityIssuePreviewCard
        inlineDraftId={draftId}
        onDraftCancelled={() => {
          requestId.current = `feedback:${issueId}:${crypto.randomUUID()}`;
          setDraftId(null);
          onStatusChange('confirmed');
        }}
      />
    );
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        onClick={createDraft}
        className="rounded border border-cafe/30 px-3 py-1.5 text-xs font-medium"
      >
        创建 GitHub 草稿
      </button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
