import type { MessageSearchResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import type { ChatReadingPort } from '../../thread-chat/useThreadChatReadingPort';
import { type MessageSearchHost, useMessageSearchHost } from '../useMessageSearchHost';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const availableSource = (url: string) => {
  const params = new URL(url, 'https://example.test').searchParams;
  return Response.json({
    status: 'available',
    updated: false,
    target: {
      threadId: params.get('threadId'),
      ...(params.has('messageId') ? { messageId: params.get('messageId'), contentRevision: 'rev' } : {}),
    },
  });
};

const response: MessageSearchResponse = {
  searchId: 'fixed-query',
  query: 'key',
  results: [
    ['origin', 'one'],
    ['origin', 'two'],
    ['other', 'three'],
  ].map(([threadId, messageId]) => ({
    threadId,
    messageId,
    speaker: 'user',
    timestamp: 100,
    timelineOrderAt: 100,
    threadTitle: 'Thread',
    snippet: { text: 'private body is not navigation state', start: 0, end: 36, source: 'body' },
    highlights: [],
    match: 'lexical',
    contentRevision: 'rev',
    publiclyQuotable: true,
  })),
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: false,
    hasMore: false,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    freshness: 'unknown',
    sourceCoverage: 'unknown',
    response: { budgetChars: 24000, serializedChars: 100, truncated: false, continuation: 'unavailable' },
  },
};

function port(threadId = 'origin'): ChatReadingPort {
  return {
    threadId,
    ownerId: 'foreground',
    captureReadingRef: vi.fn(() => ({ ref: 'immutable-origin', persisted: true })),
    navigateToMessage: vi.fn(async (messageId) => ({
      status: 'settled' as const,
      threadId,
      messageId,
      position: { anchor: 'offset' as const, top: 100, messageAnchor: { messageId, viewportOffsetPx: 0 } },
    })),
    restoreReadingRef: vi.fn(async () => ({
      status: 'settled' as const,
      exact: true,
      position: { anchor: 'bottom' as const, top: 500 },
    })),
    releaseReadingRef: vi.fn(() => true),
  };
}

describe('search Host drives the original reader', () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: MessageSearchHost;
  const route = vi.fn();
  function Harness({ threadId, available }: { threadId: string; available: boolean }) {
    current = useMessageSearchHost({ threadId, pushThreadRoute: route, available });
    return null;
  }
  function render(threadId = 'origin', available = true) {
    act(() => root.render(<Harness threadId={threadId} available={available} />));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    route.mockClear();
    vi.mocked(apiFetch)
      .mockReset()
      .mockImplementation(async (url) => availableSource(url));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('captures once on click and advances only through exact owner receipts', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    expect(reader.captureReadingRef).not.toHaveBeenCalled();
    await act(async () => current.navigateResult(response.results[0], response));
    expect(current.session?.trip.settledIndex).toBe(0);
    await act(async () => current.moveTo(1));
    expect(current.session?.trip.settledIndex).toBe(1);
    expect(reader.captureReadingRef).toHaveBeenCalledOnce();
    expect(current.session?.trip.origin.readingRef).toBe('immutable-origin');
    await act(async () => current.returnToOrigin());
    expect(reader.restoreReadingRef).toHaveBeenCalledWith('immutable-origin', expect.any(AbortSignal), {
      refresh: true,
    });
    expect(reader.releaseReadingRef).toHaveBeenCalledWith('immutable-origin');
    expect(current.session?.trip.status).toBe('completed');
  });
  it('unavailable presentation rejects stale open and navigation callbacks without capturing or writing a session', async () => {
    const reader = port();
    render('origin', false);
    act(() => current.registerReadingPort(reader));
    await act(async () => {
      current.openSearch();
      current.navigateResult(response.results[0], response);
    });
    expect(current.open).toBe(false);
    expect(current.session).toBeNull();
    expect(reader.captureReadingRef).not.toHaveBeenCalled();
    expect(reader.navigateToMessage).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('rejects callbacks retained from v2 after presentation becomes unavailable', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    const oldOpen = current.openSearch;
    const oldNavigate = current.navigateResult;
    render('origin', false);
    await act(async () => {
      oldOpen();
      oldNavigate(response.results[0], response);
    });
    expect(current.open).toBe(false);
    expect(current.session).toBeNull();
    expect(reader.captureReadingRef).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it('routes across threads and waits for the original foreground reader to register', async () => {
    const origin = port();
    act(() => current.registerReadingPort(origin));
    await act(async () => current.navigateResult(response.results[2], response));
    expect(route).toHaveBeenCalledWith('other');
    expect(current.session?.trip.settledIndex).toBeNull();
    const target = port('other');
    render('other');
    await act(async () => current.registerReadingPort(target));
    expect(target.navigateToMessage).toHaveBeenCalledWith('three', expect.any(AbortSignal), { refresh: true });
    expect(current.session?.trip.settledIndex).toBe(2);
    await act(async () => current.returnToOrigin());
    expect(route).toHaveBeenLastCalledWith('origin');
    render();
    await act(async () => current.registerReadingPort(origin));
    expect(current.session?.trip.status).toBe('completed');
    expect(origin.captureReadingRef).toHaveBeenCalledOnce();
  });

  it('rechecks a cached source before reading, preserving return after revocation', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await act(async () => current.navigateResult(response.results[0], response));
    expect(reader.navigateToMessage).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(current.session?.trip).toMatchObject({ status: 'unavailable', settledIndex: null });
    expect(current.session?.trip.origin.readingRef).toBe('immutable-origin');
    await act(async () => current.returnToOrigin());
    expect(reader.restoreReadingRef).toHaveBeenCalledOnce();
    expect(current.session?.trip.status).toBe('completed');
  });

  it('cannot change the route for a deleted cross-thread source', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
    await act(async () => current.navigateResult(response.results[2], response));
    expect(route).not.toHaveBeenCalled();
    expect(reader.navigateToMessage).not.toHaveBeenCalled();
    expect(current.session?.trip.status).toBe('unavailable');
  });

  it('fences a late source admission behind a newer explicit target', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    let finish!: (response: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => current.navigateResult(response.results[2], response));
    await act(async () => current.moveTo(1));
    await act(async () => finish(availableSource('/?threadId=other&messageId=three')));
    expect(route).not.toHaveBeenCalled();
    expect(reader.navigateToMessage).toHaveBeenCalledExactlyOnceWith('two', expect.any(AbortSignal), { refresh: true });
    expect(current.session?.trip.settledIndex).toBe(1);
  });

  it('ignores a late first arrival and cannot settle a substituted message', async () => {
    const reader = port();
    let finish: (receipt: Awaited<ReturnType<ChatReadingPort['navigateToMessage']>>) => void = () => {};
    vi.mocked(reader.navigateToMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => current.registerReadingPort(reader));
    await act(async () => current.navigateResult(response.results[0], response));
    await act(async () => current.moveTo(1));
    await act(async () =>
      finish({ status: 'settled', threadId: 'origin', messageId: 'one', position: { anchor: 'bottom', top: 0 } }),
    );
    expect(current.session?.trip.settledIndex).toBe(1);
    vi.mocked(reader.navigateToMessage).mockResolvedValueOnce({
      status: 'settled',
      threadId: 'origin',
      messageId: 'forged',
      position: { anchor: 'bottom', top: 0 },
    });
    await act(async () => current.moveTo(0));
    expect(current.session?.trip).toMatchObject({ settledIndex: 1, status: 'unavailable' });
  });

  it('keeps return available after inexact recovery, and restores a cold session without automatic scrolling', async () => {
    const reader = port();
    act(() => current.registerReadingPort(reader));
    await act(async () => current.navigateResult(response.results[0], response));
    vi.mocked(reader.restoreReadingRef).mockResolvedValueOnce({
      status: 'settled',
      exact: false,
      position: { anchor: 'bottom', top: 0 },
    });
    await act(async () => current.returnToOrigin());
    expect(current.session?.trip.status).toBe('unavailable');
    expect(reader.releaseReadingRef).not.toHaveBeenCalled();
    const originalId = current.session?.id;
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(current.session?.id).toBe(originalId);
    const coldReader = port();
    act(() => current.registerReadingPort(coldReader));
    expect(coldReader.navigateToMessage).not.toHaveBeenCalled();
    expect(coldReader.captureReadingRef).not.toHaveBeenCalled();
    await act(async () => current.returnToOrigin());
    expect(current.session?.trip.status).toBe('completed');
  });

  it('keeps a pointer write failure visible even when later session writes succeed', async () => {
    const set = Storage.prototype.setItem;
    const writer = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'cat-cafe:message-reading-active:v1') throw new Error('pointer denied');
      set.call(this, key, value);
    });
    const reader = port();
    act(() => current.registerReadingPort(reader));
    await act(async () => current.navigateResult(response.results[0], response));
    expect(current.persisted).toBe(false);
    writer.mockRestore();
  });

  it('withdraws pending intents when F307 hides history, preserving the original return point', async () => {
    const reader = port();
    let finish: (receipt: Awaited<ReturnType<ChatReadingPort['navigateToMessage']>>) => void = () => {};
    vi.mocked(reader.navigateToMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => current.registerReadingPort(reader));
    await act(async () => current.navigateResult(response.results[0], response));
    render('origin', false);
    await act(async () =>
      finish({ status: 'settled', threadId: 'origin', messageId: 'one', position: { anchor: 'bottom', top: 0 } }),
    );
    expect(current.session?.trip).toMatchObject({
      status: 'interrupted',
      settledIndex: null,
      origin: { readingRef: 'immutable-origin' },
    });
    expect(reader.releaseReadingRef).not.toHaveBeenCalled();
  });
});
