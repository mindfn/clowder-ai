import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePerfTracker } from '../perf';
import type { ChatPort } from '../types';

function makePort(overrides?: Partial<ChatPort>): ChatPort {
  let currentThread = 'thread_alpha';
  return {
    get threadId() {
      return currentThread;
    },
    exportReady: Promise.resolve(),
    state: {} as ChatPort['state'],
    needed: vi.fn(),
    sidebarData: {} as ChatPort['sidebarData'],
    data: {} as ChatPort['data'],
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ ok: true })),
    file: vi.fn((path: string) => `/api/file/${path}`),
    attach: vi.fn(),
    action: vi.fn(async (name: string) => {
      if (name === 'switch') currentThread = 'thread_beta';
      return { ok: true };
    }),
    richRender: vi.fn(),
    terminal: vi.fn(),
    navResize: {
      min: 200,
      max: () => 400,
      width: () => 260,
      preview: vi.fn(),
      commit: vi.fn(),
      reset: vi.fn(),
    },
    ...overrides,
  };
}

describe('ConsolePerfTracker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage?.removeItem('pdl:perf:verbose');
  });

  it('tracks boot asset timings, start time, and total boot summary', () => {
    const tracker = new ConsolePerfTracker();
    tracker.recordBootAsset('style', 'library/css/core.css', 12.4);
    tracker.recordBootAsset('script', '/pdl/engine/core.js', 28.6);
    tracker.recordBootAsset('script', '/pdl-app/chat.js', 45.2);
    tracker.recordBootStart(110.5);
    tracker.finishBoot(196.7);

    const summary = tracker.summary(false);
    expect(summary.boot.stylesCount).toBe(1);
    expect(summary.boot.scriptsCount).toBe(2);
    expect(summary.boot.stylesMs).toBe(12.4);
    expect(summary.boot.scriptsMs).toBe(73.8);
    expect(summary.boot.startMs).toBe(110.5);
    expect(summary.boot.totalMs).toBe(196.7);
    expect(summary.boot.slowestAssets[0]).toEqual({ kind: 'script', path: '/pdl-app/chat.js', ms: 45.2 });
    expect(tracker.recent(5).some((e) => e.kind === 'boot')).toBe(true);
    tracker.dispose();
  });

  it('tracks renders, painted vs noop counts, slow render events, and route transitions with attached GETs', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tracker = new ConsolePerfTracker();

    let resolveGet!: (value: unknown) => void;
    const rawPort = makePort({
      get: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve;
          }),
      ),
    });
    const port = tracker.instrumentPort(rawPort);
    expect(tracker.instrumentPort(rawPort)).toBe(port);
    expect(port.threadId).toBe('thread_alpha');

    // Initial render on chat
    tracker.onRenderStart({ route: 'chat', thread: 't1', settle: 1, keep: true });
    clock += 5;
    tracker.onRenderEnd({ route: 'chat', thread: 't1', settle: 2, keep: true });

    // Noop render
    tracker.onRenderStart({ route: 'chat', thread: 't1', settle: 2, keep: true });
    clock += 2;
    tracker.onRenderEnd({ route: 'chat', thread: 't1', settle: 2, keep: true });

    // Transition to members with a slow 24ms render + an in-flight API fetch
    tracker.onRenderStart({ route: 'members', thread: 't1', settle: 2, keep: false });
    const getPromise = port.get('/api/threads/thread_123456/members');
    clock += 24;
    tracker.onRenderEnd({
      route: 'members',
      thread: 't1',
      settle: 3,
      keep: false,
      changed: ['~S.route', '~vm:vm:members'],
    });

    // Finish API fetch 180ms later
    clock += 180;
    resolveGet({ items: [] });
    await getPromise;
    // Wait for rAF / microtask settle
    await new Promise((r) => setTimeout(r, 25));

    const summary = tracker.summary(false);
    expect(summary.currentRoute).toBe('members');
    expect(summary.renders.total).toBe(3);
    expect(summary.renders.painted).toBe(2);
    expect(summary.renders.noop).toBe(1);
    expect(summary.renders.maxMs).toBe(24);
    expect(summary.renders.maxPerSec).toBe(3);

    expect(summary.transitions).toHaveLength(1);
    expect(summary.transitions[0]).toMatchObject({
      route: 'members',
      count: 1,
      avgFirstRenderMs: 24,
      avgApiCalls: 1,
    });
    expect(summary.transitions[0].avgSettleMs).toBeGreaterThanOrEqual(204);

    expect(summary.api).toContainEqual(
      expect.objectContaining({
        name: 'GET /api/threads/:threadId/members',
        count: 1,
        maxMs: 204,
        errors: 0,
      }),
    );

    const recent = tracker.recent(10);
    expect(recent.find((e) => e.kind === 'render')?.detail).toMatchObject({
      changed: ['~S.route', '~vm:vm:members'],
    });
    expect(recent.some((e) => e.kind === 'api' && e.name === 'GET /api/threads/:threadId/members')).toBe(true);
    expect(recent.some((e) => e.kind === 'transition' && e.name === 'chat -> members')).toBe(true);
    tracker.dispose();
  });

  it('instruments chatModels, clowderChat pushes/update, export JSON, verbose flag, and reset', async () => {
    let clock = 500;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tracker = new ConsolePerfTracker();

    const wrappedVm = tracker.instrumentChatModels((_d: unknown, _u: unknown, _i: unknown, slice?: string) => {
      clock += 12;
      return { slice };
    });
    expect(wrappedVm({}, {}, {}, 'chatStream')).toEqual({ slice: 'chatStream' });

    const port = makePort();
    let actionPromise: unknown;
    const updateSpy = vi.fn((p?: ChatPort) => {
      clock += 4;
      if (p) actionPromise = p.action('switch', {});
    });
    const fakeChat = {
      start: vi.fn(),
      update: updateSpy,
      pushSidebar: vi.fn(() => {
        clock += 3;
        return {} as never;
      }),
      pushProject: vi.fn(() => ({})),
      pushChat: vi.fn(() => ({}) as never),
      confirm: vi.fn(),
      emit: vi.fn(),
    } as unknown as Window['clowderChat'];

    tracker.instrumentClowderChat(fakeChat);
    fakeChat.update(port);
    await actionPromise;
    fakeChat.pushSidebar({} as never);

    expect(port.threadId).toBe('thread_beta');
    const summary = tracker.summary(false);
    expect(summary.vms[0]).toMatchObject({ name: 'chatModels:chatStream', count: 1, maxMs: 12 });
    expect(summary.pushes.some((p) => p.name === 'update' && p.count === 1)).toBe(true);
    expect(summary.pushes.some((p) => p.name === 'pushSidebar' && p.count === 1)).toBe(true);
    expect(summary.api.some((a) => a.name === 'ACT switch' && a.count === 1)).toBe(true);

    const exported = JSON.parse(tracker.exportJson());
    expect(exported.summary.vms[0].name).toBe('chatModels:chatStream');

    expect(tracker.verbose()).toBe(false);
    expect(tracker.verbose(true)).toBe(true);
    expect(tracker.verbose(false)).toBe(false);

    tracker.recordBootStart(50);
    tracker.reset(false);
    expect(tracker.summary(false).vms).toEqual([]);
    expect(tracker.summary(false).boot.startMs).toBe(50);
    tracker.reset(true);
    expect(tracker.summary(false).boot.startMs).toBe(0);
    tracker.dispose();
  });
});
