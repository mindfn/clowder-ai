import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { useChatStore } from '@/stores/chatStore';
import { useGlobalArtifacts } from '../useGlobalArtifacts';
import { GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS } from '../usePagedGlobalWorks';

// 2026-10-23/24 runtime log: ~1.0M global Works page reads in 38h. Every host-thread
// material change aborted the running walk and re-read the whole catalogue from page one.
const page = (nextCursor?: string) =>
  Response.json({
    view: 'works',
    artifacts: [],
    complete: !nextCursor,
    workLineage: 'resolved',
    ...(nextCursor ? { nextCursor } : {}),
  });
const sourceChanged = (threadId?: string) =>
  window.dispatchEvent(
    threadId
      ? new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { threadId } })
      : new Event('cat-cafe:entrusted-work-projection-invalidated'),
  );
const ownerSourceChanged = () =>
  window.dispatchEvent(
    new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { ownerUserId: 'owner' } }),
  );
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

let root: Root;
const Probe = () => {
  useGlobalArtifacts(true, { view: 'works' });
  return null;
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  useChatStore.setState({
    currentThreadId: 'thread-active',
    messages: [],
    threadStates: {},
    threads: [{ id: 'thread-active', title: 'Active thread' }],
  } as never);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  setVisibility('visible');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('lets a running walk finish and coalesces repeated source changes into one later walk', async () => {
  let finishFirstPage: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishFirstPage = done;
      }),
  );
  await act(async () => root.render(<Probe />));
  const firstSignal: AbortSignal = fetch.mock.calls[0][1].signal;

  await act(async () => {
    ownerSourceChanged();
    ownerSourceChanged();
    ownerSourceChanged();
  });
  expect(firstSignal.aborted).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);

  fetch.mockResolvedValueOnce(page('two')).mockResolvedValueOnce(page()).mockResolvedValue(page());
  await act(async () => finishFirstPage(page()));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS));
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/artifacts?view=works&read=pages',
    '/api/artifacts?view=works&read=pages',
    '/api/artifacts?view=works&read=pages&cursor=two',
  ]);

  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS * 4));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('defers a source refresh while the tab is hidden and runs it once when visible', async () => {
  fetch.mockResolvedValue(page());
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => setVisibility('hidden'));
  await act(async () => {
    ownerSourceChanged();
    ownerSourceChanged();
  });
  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS * 4));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => setVisibility('visible'));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('replaces one changed thread without walking a 1,500-page catalogue again', async () => {
  const old = {
    type: 'file',
    name: 'old',
    catId: 'codex',
    threadId: 'thread-active',
    threadTitle: 'Active thread',
    createdAt: 1,
    sourceMessageId: 'old',
  };
  const other = { ...old, name: 'other', threadId: 'thread-other', threadTitle: 'Other', sourceMessageId: 'other' };
  let globalPage = 0;
  let threadRead = 0;
  const readGlobalPage = () => {
    globalPage += 1;
    const nextCursor = globalPage < 1_500 ? `page-${globalPage + 1}` : undefined;
    return Promise.resolve(
      Response.json({
        view: 'works',
        artifacts: globalPage === 1 ? [old, other] : [],
        complete: !nextCursor,
        workLineage: 'resolved',
        ...(nextCursor ? { nextCursor } : {}),
      }),
    );
  };
  const readThread = () => {
    threadRead += 1;
    if (threadRead === 2) return Promise.resolve(new Response('', { status: 403 }));
    return Promise.resolve(
      Response.json({
        threadId: 'thread-active',
        view: 'works',
        artifacts: [{ ...old, name: 'fresh', sourceMessageId: 'fresh' }],
        total: 1,
        complete: true,
        workLineage: 'resolved',
      }),
    );
  };
  fetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/artifacts?view=works&read=pages')) return readGlobalPage();
    if (url === '/api/threads/thread-active/artifacts?view=works') return readThread();
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });

  let names: string[] = [];
  const ResultProbe = () => {
    names = useGlobalArtifacts(true, { view: 'works' }).artifacts.map((item) => item.name);
    return null;
  };
  await act(async () => root.render(<ResultProbe />));
  expect(fetch).toHaveBeenCalledTimes(1_500);
  expect(names).toEqual(['old', 'other']);

  await act(async () => sourceChanged('thread-active'));

  expect(fetch).toHaveBeenCalledTimes(1_501);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/threads/thread-active/artifacts?view=works');
  expect(names).toEqual(['fresh', 'other']);
  await act(async () => vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS * 4));
  expect(fetch).toHaveBeenCalledTimes(1_501);

  await act(async () => sourceChanged('thread-active'));
  expect(fetch).toHaveBeenCalledTimes(1_502);
  expect(names).toEqual(['other']);
});

it('ignores prose-only timeline activity and refreshes a newly published file by thread', async () => {
  fetch.mockResolvedValueOnce(page()).mockResolvedValueOnce(
    Response.json({
      threadId: 'thread-active',
      view: 'works',
      artifacts: [],
      total: 0,
      complete: true,
      workLineage: 'resolved',
    }),
  );
  await act(async () => root.render(<Probe />));
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () =>
    useChatStore.setState({
      messages: [{ id: 'prose', type: 'assistant', content: 'still working', timestamp: 1 }],
    } as never),
  );
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () =>
    useChatStore.setState({
      messages: [
        { id: 'prose', type: 'assistant', content: 'still working', timestamp: 1 },
        {
          id: 'file',
          type: 'assistant',
          content: '',
          timestamp: 2,
          contentBlocks: [{ type: 'file', fileName: 'result.pdf', url: '/uploads/result.pdf' }],
        },
      ],
    } as never),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/threads/thread-active/artifacts?view=works');
});
