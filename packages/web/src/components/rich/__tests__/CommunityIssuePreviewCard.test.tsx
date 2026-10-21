import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from '../CommunityIssuePreviewCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const draft = {
  draftId: 'draft/a#1',
  status: 'draft',
  title: 'Issue',
  bodyMarkdown: 'Details',
  targetRepo: 'owner/repo',
  labels: [],
};
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts/by-id/draft%2Fa%231';
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ draft }) } as Response);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
for (const action of ['publish', 'cancel'] as const) {
  it(`hydrates and sends ${action} through the plugin by-id path with a single encoded identifier`, async () => {
    await act(async () => {
      root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />);
    });
    expect(apiFetch).toHaveBeenCalledWith(endpoint);
    const button = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === (action === 'publish' ? 'Submit to GitHub' : 'Cancel'),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`${endpoint}/${action}`, expect.objectContaining({ method: 'POST' }));
  });
}

it('uncertain publication stays visible and frozen until reconciliation returns a published issue', async () => {
  const pending = { ...draft, status: 'publishing' };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ draft }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ draft: pending, warning: 'Publication outcome uncertain' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        draft: {
          ...pending,
          status: 'published',
          githubIssueUrl: 'https://github.com/owner/repo/issues/7',
          githubIssueNumber: 7,
        },
      }),
    } as Response);
  await act(async () => root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).not.toContain('Published to Community');
  expect(container.textContent).toContain('Publication outcome uncertain');
  expect(container.querySelector('input')?.disabled).toBe(true);
  expect(
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')?.disabled,
  ).toBe(true);
  expect(container.textContent).toContain('查询发布结果');
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('a')?.href).toBe('https://github.com/owner/repo/issues/7');
});
