import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '../ArtworkLightboxScope';

let scope: NonNullable<ReturnType<typeof useArtworkLightboxScope>>;
function Consumer() {
  scope = useArtworkLightboxScope()!;
  return null;
}
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="thread-a">
        <Consumer />
      </ArtworkLightboxProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function work(path: string) {
  return {
    url: `http://api.test/${path}`,
    title: path,
    alt: path,
    mediaType: 'image' as const,
    surface: createFilePreviewSurface({
      worktreeId: 'listed-alias',
      path,
      navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-a', messageId: `original-${path}` },
    }),
  };
}
it('canonical file resolution in a float retains the original Chat return without changing Workbench topology', async () => {
  const before = useF307ExperienceWorkbenchStore.getState();
  const original = work('original.png');
  await act(async () => scope.open(original));
  await act(async () =>
    scope.resolve(createFilePreviewSurface({ worktreeId: 'canonical-root', path: 'original.png' })),
  );
  expect(scope.work?.surface?.navigationOrigin).toEqual(original.surface.navigationOrigin);
  expect(scope.work?.surface?.ownerStateRef.key).toBe('canonical-root');
  expect(useF307ExperienceWorkbenchStore.getState()).toBe(before);
});
it('a late resolution from a previous floating work cannot replace the newly opened work', async () => {
  await act(async () => scope.open(work('first.png')));
  const late = scope.resolve;
  const next = work('second.png');
  await act(async () => scope.open(next));
  await act(async () => late(createFilePreviewSurface({ worktreeId: 'canonical-root', path: 'first.png' })));
  expect(scope.work).toBe(next);
});
