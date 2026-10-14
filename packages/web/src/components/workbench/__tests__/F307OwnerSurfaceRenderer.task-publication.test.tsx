import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createArtifactReviewSurface } from '../artifact-review-surface';
import { F307OwnerSurfaceRenderer } from '../F307OwnerSurfaceRenderer';

vi.mock('@/components/content-review/ArtifactReviewSurface', () => ({
  ArtifactReviewSurface: ({
    reviewId,
    initialRound,
    titleInHost,
    leadingAction,
  }: {
    reviewId: string;
    initialRound?: number;
    titleInHost?: boolean;
    leadingAction?: ReactNode;
  }) => (
    <section
      data-testid="original-task-owner"
      data-review={reviewId}
      data-round={initialRound}
      data-title-in-host={String(titleInHost ?? false)}
    >
      <header>{leadingAction}</header>
    </section>
  ),
}));
const source = {
  kind: 'message' as const,
  threadId: 'thread-source',
  messageId: 'published',
  messageRevision: '42',
  expectedUrl: '/uploads/original.png',
  item: { kind: 'content-block' as const, index: 0 },
};
const surface = {
  ...createArtifactReviewSurface(`review-${'a'.repeat(64)}`, source.threadId, '原作品', 2),
  messagePublicationSource: source,
};
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
for (const shell of ['v2', 'classic']) {
  it(`forwards the original Task round and ${shell === 'v2' ? 'compact slot' : 'standalone title'} in ${shell}`, async () => {
    localStorage.setItem('cat-cafe:shell-presentation', shell);
    await act(async () =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={vi.fn()}
          onOpenArtifactWithReturn={vi.fn()}
          onRefreshSurface={vi.fn()}
          onRequestDetach={vi.fn()}
        />,
      ),
    );
    const owner = element.querySelector('[data-testid="original-task-owner"]');
    expect(owner?.getAttribute('data-review')).toBe(surface.objectRef.id);
    expect(owner?.getAttribute('data-round')).toBe('2');
    expect(owner?.getAttribute('data-title-in-host')).toBe('false');
    const trigger = [...element.querySelectorAll('button')].find((button) => button.textContent === '切换原作品');
    expect(trigger).toBeDefined();
    expect(Boolean(trigger?.closest('header'))).toBe(shell === 'v2');
  });
}
