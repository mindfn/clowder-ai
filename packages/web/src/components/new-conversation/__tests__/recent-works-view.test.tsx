import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  result: {
    artifacts: [] as GlobalArtifactDTO[],
    workLineage: 'unavailable' as const,
    loading: false,
    error: false,
    complete: true,
    refetch: vi.fn(),
  },
  useGlobalArtifacts: vi.fn(),
}));

vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (...args: unknown[]) => {
    mocks.useGlobalArtifacts(...args);
    return mocks.result;
  },
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ id: 'codex-sol', displayName: '砚砚' }) }),
}));
vi.mock('../../shell/ShellCatAvatar', () => ({
  knownCatName: () => '砚砚',
  ShellCatAvatar: () => <span data-testid="cat-avatar" />,
}));

import { RecentWorks } from '../RecentWorks';

function artifact(name: string, createdAt: number): GlobalArtifactDTO {
  return {
    type: 'image',
    name,
    catId: 'codex-sol',
    createdAt,
    sourceMessageId: `message-${name}`,
    url: `/uploads/${name}.png`,
    publicationItem: { kind: 'content-block', index: 0 },
    threadId: 'thread-a',
    threadTitle: 'Thread A',
  };
}

describe('RecentWorks bounded read states', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.useGlobalArtifacts.mockClear();
    mocks.result = {
      artifacts: [],
      workLineage: 'unavailable',
      loading: false,
      error: false,
      complete: true,
      refetch: vi.fn(),
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => root.render(<RecentWorks onOpen={vi.fn()} onOpenAll={vi.fn()} />));
  }

  it('asks for three bounded recent works and shows partial results even when the scan is incomplete', () => {
    mocks.result = {
      ...mocks.result,
      artifacts: [artifact('one', 2), artifact('two', 1)],
      complete: false,
    };
    render();

    expect(mocks.useGlobalArtifacts).toHaveBeenCalledWith(true, { view: 'recent-works', limit: 3 });
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('treats zero results from an incomplete scan as a retryable failure, not an empty café', () => {
    mocks.result = { ...mocks.result, complete: false };
    render();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('最近的作品暂时没有读到');
    expect(host.textContent).not.toContain('还没有最近的作品');
  });

  it('shows the genuine empty state only after the bounded scan is complete', () => {
    render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('还没有最近的作品');
  });
});
