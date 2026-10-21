import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityPublishFlow } from '../CommunityPublishFlow';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
for (const action of ['publish', 'cancel'])
  test(`confirmed feedback reaches inline preview and ${action}`, async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const draft = {
      draftId: 'draft-1',
      targetRepo: 'org/repo',
      title: 'Visible title',
      bodyMarkdown: 'Visible body',
      labels: [],
      status: 'draft',
    };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      const path = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (path.endsWith('/config')) return { defaultRepo: 'org/repo', repos: ['org/repo'] };
          if (path.endsWith('/publish'))
            return {
              draft: {
                ...draft,
                status: 'published',
                githubIssueNumber: 7,
                githubIssueUrl: 'https://github.com/org/repo/issues/7',
              },
            };
          if (path.endsWith('/cancel')) return { draft: { ...draft, status: 'cancelled' } };
          if (path.includes('/by-id/')) return { draft };
          return { data: { id: draft.draftId, repo: draft.targetRepo, ...draft } };
        },
      } as Response;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onStatusChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CommunityPublishFlow
            issueId="fi_1"
            title="Visible title"
            bodyMarkdown="Visible body"
            status="confirmed"
            onStatusChange={onStatusChange}
          />,
        ),
      );
      await act(async () => container.querySelector('button')!.click());
      const write = calls.find((call) => call.init?.method === 'POST')!;
      expect(write.url).toBe('/api/plugins/official.github-operations/github/community-issue-drafts');
      expect(JSON.parse(write.init!.body as string)).toEqual({
        requestId: 'feedback:fi_1',
        repo: 'org/repo',
        title: 'Visible title',
        bodyMarkdown: 'Visible body',
      });
      expect(container.querySelector('input')?.value).toBe('Visible title');
      const button = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === (action === 'publish' ? 'Submit to GitHub' : 'Cancel'),
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(calls.at(-1)?.url).toBe(
        `/api/plugins/official.github-operations/github/community-issue-drafts/by-id/draft-1/${action}`,
      );
      if (action === 'publish') expect(container.querySelector('a')?.href).toBe('https://github.com/org/repo/issues/7');
      else {
        expect(onStatusChange).toHaveBeenLastCalledWith('confirmed');
        expect(container.textContent).toContain('创建 GitHub 草稿');
        await act(async () => container.querySelector('button')!.click());
        const creates = calls.filter(
          (call) => call.url.endsWith('/community-issue-drafts') && call.init?.method === 'POST',
        );
        expect(creates).toHaveLength(2);
        expect(JSON.parse(creates[0].init!.body as string).requestId).not.toBe(
          JSON.parse(creates[1].init!.body as string).requestId,
        );
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
