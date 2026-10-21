/**
 * F235 Phase B: CommunityIssueDraftCard — routing + render tests.
 *
 * Uses SSR (renderToStaticMarkup) to test initial render state without
 * browser environment. API calls (useEffect-driven) don't fire in SSR,
 * so we test the static "editing" state only. Integration tests for the
 * full create → publish flow happen at the API layer (Task 2 + Task 5).
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssueDraftCard, isCommunityIssueDraftBlock } from '../CommunityIssueDraftCard';
import { RichBlocks } from '../RichBlocks';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const draftBlock = {
  id: 'b_draft_1',
  kind: 'card' as const,
  v: 1 as const,
  title: 'Publish to Community',
  bodyMarkdown: 'Cat suggests publishing this issue.',
  tone: 'info' as const,
  meta: {
    kind: 'community_issue_draft',
    proposedTitle: 'Bug: tool calls fail silently',
    proposedBody: '## Problem\n\nTool calls return empty response.',
    proposedRepo: 'clowder-ai/cat-cafe',
    proposedLabels: ['bug', 'ux'],
  },
};

describe('isCommunityIssueDraftBlock', () => {
  it('returns true for community_issue_draft meta.kind', () => {
    expect(isCommunityIssueDraftBlock(draftBlock)).toBe(true);
  });

  it('returns false for other meta.kind', () => {
    expect(
      isCommunityIssueDraftBlock({
        ...draftBlock,
        meta: { kind: 'callback_auth_failure' },
      }),
    ).toBe(false);
  });

  it('returns false when meta is undefined', () => {
    expect(isCommunityIssueDraftBlock({ ...draftBlock, meta: undefined })).toBe(false);
  });

  it('does NOT require connector provenance (cat messages are inherently trusted)', () => {
    // Phase A preview cards require messageSource.connector === 'community-publisher'.
    // Phase B draft cards come from cats — no connector check needed (OQ-2).
    expect(isCommunityIssueDraftBlock(draftBlock)).toBe(true);
  });
});

describe('CommunityIssueDraftCard', () => {
  it('renders editable title from meta', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Bug: tool calls fail silently'); // proposedTitle in input value
    expect(html).toContain('Publish to Community'); // header
    expect(html).toContain('draft'); // badge
  });

  it('renders editable body from meta', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Tool calls return empty response');
  });

  it('renders proposed labels', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('bug, ux');
  });

  it('renders submit and cancel buttons', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Submit to GitHub');
    expect(html).toContain('Cancel');
  });

  it('renders repo input (fallback when config not yet loaded)', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    // On SSR, repos array is empty → renders text input with proposedRepo value
    expect(html).toContain('clowder-ai/cat-cafe');
    expect(html).toContain('Target Repository');
  });
});

describe('RichBlocks routing to CommunityIssueDraftCard', () => {
  it('routes community_issue_draft card to CommunityIssueDraftCard', () => {
    const html = renderToStaticMarkup(<RichBlocks blocks={[draftBlock]} />);
    // CommunityIssueDraftCard renders "Submit to GitHub" button — default CardBlock doesn't
    expect(html).toContain('Submit to GitHub');
    expect(html).toContain('draft'); // badge
  });

  it('does NOT route regular card blocks to CommunityIssueDraftCard', () => {
    const regularCard = {
      id: 'b_regular',
      kind: 'card' as const,
      v: 1 as const,
      title: 'Just a card',
      bodyMarkdown: 'Nothing special',
    };
    const html = renderToStaticMarkup(<RichBlocks blocks={[regularCard]} />);
    expect(html).not.toContain('Submit to GitHub');
    expect(html).toContain('Just a card');
  });
});

it('cat card retains one draft and queries an uncertain publication without marking it published', async () => {
  const draft = { draftId: 'saved-draft', title: 'Bug', bodyMarkdown: 'Body', status: 'publishing' };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ defaultRepo: 'org/repo', repos: ['org/repo'] }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ draft: { ...draft, status: 'draft' } }) } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ draft, warning: 'Publication outcome uncertain' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        draft: {
          ...draft,
          status: 'published',
          githubIssueNumber: 7,
          githubIssueUrl: 'https://github.com/org/repo/issues/7',
        },
      }),
    } as Response);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CommunityIssueDraftCard block={draftBlock} messageId="message-1" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).not.toContain('Published to Community');
    expect(container.textContent).toContain('Publication outcome uncertain');
    expect(container.querySelector('input')?.disabled).toBe(true);
    expect(container.textContent).toContain('查询发布结果');
    expect(
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')?.disabled,
    ).toBe(true);
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('a')?.href).toBe('https://github.com/org/repo/issues/7');
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.filter(([url, init]) => String(url).endsWith('/community-issue-drafts') && init?.method === 'POST'),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('a saved native draft opens the existing preview without creating another draft', async () => {
  const id = 'a'.repeat(64);
  const draft = {
    draftId: id,
    status: 'draft',
    title: 'Saved title',
    bodyMarkdown: 'Saved text',
    targetRepo: 'org/repo',
    labels: [],
  };
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () =>
        String(url).endsWith('/config') ? { repos: ['org/repo'], defaultRepo: 'org/repo' } : { draft },
    } as Response;
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<CommunityIssueDraftCard block={{ ...draftBlock, meta: { ...draftBlock.meta, draftId: id } }} />),
    );
    expect(container.querySelector('input')?.value).toBe('Saved title');
    expect(calls).toContain(`/api/plugins/official.github-operations/github/community-issue-drafts/by-id/${id}`);
    expect(calls.every((url) => url.endsWith('/config') || url.includes('/by-id/'))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
