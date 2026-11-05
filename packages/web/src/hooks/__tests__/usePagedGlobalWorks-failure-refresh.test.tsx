import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { invalidateArtifactReviewAccess } from '@/components/content-review/review-access-invalidation';
import { useChatStore } from '@/stores/chatStore';
import { useGlobalArtifacts } from '../useGlobalArtifacts';
import { usePagedGlobalWorks } from '../usePagedGlobalWorks';

let root: Root;
let result: ReturnType<typeof usePagedGlobalWorks>;

const Probe = () => {
  result = usePagedGlobalWorks(true);
  return null;
};
const artifact = (name: string, threadId = 'A'): GlobalArtifactDTO => ({
  type: 'file',
  name,
  catId: 'codex',
  threadId,
  threadTitle: threadId,
  createdAt: 1,
  sourceMessageId: name,
});
const page = (names: string[], nextCursor?: string) =>
  Response.json({
    view: 'works',
    artifacts: names.map((name) => artifact(name)),
    workLineage: 'resolved',
    complete: !nextCursor,
    ...(nextCursor ? { nextCursor } : {}),
  });
const slice = (name: string) =>
  Response.json({
    threadId: 'A',
    view: 'works',
    artifacts: [artifact(name)],
    workLineage: 'resolved',
    complete: true,
    total: 1,
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('retains a queued thread refresh while a failed catalogue walk resumes', async () => {
  let fail!: (error: Error) => void;
  fetch.mockResolvedValueOnce(page(['old'], 'two')).mockImplementationOnce(
    () =>
      new Promise((_ok, reject) => {
        fail = reject;
      }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => result.refreshThread('A'));
  await act(async () => fail(new Error('temporary page failure')));
  expect(result.error).toBe(true);

  fetch.mockResolvedValueOnce(page(['other'])).mockResolvedValueOnce(slice('fresh'));
  await act(async () => result.refetch());

  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/threads/A/artifacts?view=works');
  expect(result.complete).toBe(true);
  expect(result.artifacts.map((item) => item.name)).toContain('fresh');
  expect(result.artifacts.map((item) => item.name)).not.toContain('old');
});

it('does not claim completeness after one thread refresh fails and another is revoked', async () => {
  fetch
    .mockResolvedValueOnce(page(['old']))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 403 }));
  await act(async () => root.render(<Probe />));
  await act(async () => {
    result.refreshThread('A');
    result.refreshThread('B');
  });

  expect(result.complete).toBe(false);
  expect(result.error).toBe(true);
});

it('does not let an older thread response clear a newer invalidation', async () => {
  let resolveFirst!: (response: Response) => void;
  fetch.mockResolvedValueOnce(page(['old'])).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => result.refreshThread('A'));
  await act(async () => result.refreshThread('A'));

  fetch.mockResolvedValueOnce(slice('newest'));
  await act(async () => resolveFirst(slice('stale')));

  expect(result.complete).toBe(true);
  expect(result.artifacts.map((item) => item.name)).toContain('newest');
  expect(result.artifacts.map((item) => item.name)).not.toContain('stale');
});

it('does not attribute an unscoped review revocation to the host thread', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  useChatStore.setState({ currentThreadId: 'A', messages: [], threadStates: {}, threads: [] } as never);
  let names: string[] = [];
  const GlobalProbe = () => {
    names = useGlobalArtifacts(true, { view: 'works' }).artifacts.map((item) => item.name);
    return null;
  };
  let globals = 0;
  fetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/artifacts?')) {
      globals += 1;
      return Promise.resolve(
        Response.json({
          view: 'works',
          artifacts: globals === 1 ? [artifact('revoked-B', 'B')] : [],
          workLineage: 'resolved',
          complete: true,
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        threadId: 'A',
        view: 'works',
        artifacts: [],
        workLineage: 'resolved',
        complete: true,
      }),
    );
  });
  await act(async () => root.render(<GlobalProbe />));
  expect(names).toEqual(['revoked-B']);

  await act(async () => invalidateArtifactReviewAccess('review-B-unscoped-regression'));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));

  expect(names).not.toContain('revoked-B');
});
