import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePerfTracker, MAX_BUCKETS, MAX_MEASURES } from '../perf';
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

  it('redacts URLs, raw API paths, entity params, DOM ids, and VM args before writing or exporting', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    window.history.replaceState({}, '', '/thread/thread_SENTINEL_URL_ID?token=SENTINEL_QUERY_SECRET#SENTINEL_HASH');

    const tracker = new ConsolePerfTracker();
    const rawPort = makePort({
      get: vi.fn(async () => {
        clock += 210;
        return { ok: true };
      }),
      post: vi.fn(async () => {
        clock += 220;
        return { ok: true };
      }),
    });
    const port = tracker.instrumentPort(rawPort);

    tracker.onRenderStart({
      route: 'chat',
      param: 'thread_SENTINEL_PARAM_ID',
      thread: 'thread_SENTINEL_THREAD_ID',
      panel: 'file:/Users/SENTINEL_USER/secret.ts',
      settle: 1,
      keep: false,
    });
    await port.get('/api/threads/thread_SENTINEL_API_ID/messages/msg_SENTINEL_MSG_ID?q=SENTINEL_API_QUERY');
    await port.post('/api/cats/cat-SENTINEL_CAT_ID/plugins/p_SENTINEL_PLUGIN_ID?secret=SENTINEL_POST_SECRET', {}, {});
    clock += 30;
    tracker.onRenderEnd({
      route: 'chat',
      param: 'thread_SENTINEL_PARAM_ID',
      thread: 'thread_SENTINEL_THREAD_ID',
      panel: 'file:/Users/SENTINEL_USER/secret.ts',
      settle: 2,
      keep: false,
      changed: ['~vm:chatStream|{"threadId":"SENTINEL_VM_ARG","body":"SENTINEL_BODY"}', '~S.draft.SENTINEL_DRAFT_KEY'],
    });

    const btn = document.createElement('button');
    btn.id = 'msg-SENTINEL_DOM_ID';
    btn.className = 'SENTINEL_CLASS_NAME';
    btn.setAttribute('data-act', 'thread_SENTINEL_ACT_ID');
    tracker.recordInteraction('click', btn, 85);

    const exported = tracker.exportJson();
    const sentinels = [
      'SENTINEL_URL_ID',
      'SENTINEL_QUERY_SECRET',
      'SENTINEL_HASH',
      'SENTINEL_PARAM_ID',
      'SENTINEL_THREAD_ID',
      'SENTINEL_USER',
      'SENTINEL_API_ID',
      'SENTINEL_MSG_ID',
      'SENTINEL_API_QUERY',
      'SENTINEL_CAT_ID',
      'SENTINEL_PLUGIN_ID',
      'SENTINEL_POST_SECRET',
      'SENTINEL_VM_ARG',
      'SENTINEL_BODY',
      'SENTINEL_DRAFT_KEY',
      'SENTINEL_DOM_ID',
      'SENTINEL_CLASS_NAME',
      'SENTINEL_ACT_ID',
    ];
    for (const s of sentinels) {
      expect(exported).not.toContain(s);
    }

    const parsed = JSON.parse(exported);
    expect(parsed.url).toBeUndefined();
    expect(parsed.path).toBe('/thread/:threadId');
    expect(parsed.summary.currentRoute).toBe('chat::param[:panel]');
    expect(parsed.recent.find((e: { kind: string }) => e.kind === 'render')?.detail?.changed).toEqual([
      '~vm:chatStream',
      '~S.draft',
    ]);
    expect(parsed.recent.find((e: { kind: string }) => e.kind === 'api')?.detail?.path).toBe(
      '/api/threads/:threadId/messages/:msgId',
    );
    window.history.replaceState({}, '', '/');
    tracker.dispose();
  });

  it('bounds all bucket maps under high cardinality and caps/clears performance.measure entries', async () => {
    let clock = 2000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const measureSpy = vi.spyOn(performance, 'measure').mockImplementation(() => ({}) as PerformanceMeasure);
    const clearSpy = vi.spyOn(performance, 'clearMeasures').mockImplementation(() => {});

    const tracker = new ConsolePerfTracker();
    const port = tracker.instrumentPort(makePort());

    // Default (verbose=false): slow renders must not accumulate performance.measure entries
    for (let i = 0; i < MAX_BUCKETS + 40; i += 1) {
      const route = `view${i}`;
      tracker.onRenderStart({ route, settle: i, keep: false });
      clock += 20;
      tracker.onRenderEnd({ route, settle: i + 1, keep: false });
      await port.get(`/api/ep${i}`);
      tracker.recordInteraction('click', document.createElement('button'), 50);
    }
    expect(measureSpy).not.toHaveBeenCalled();

    // Verify internal maps are strictly capped at MAX_BUCKETS + 1 (overflow bucket)
    const internals = tracker as unknown as {
      renderBuckets: Map<string, unknown>;
      apiBuckets: Map<string, unknown>;
      transitionBuckets: Map<string, unknown>;
      interactionBuckets: Map<string, unknown>;
    };
    expect(internals.renderBuckets.size).toBeLessThanOrEqual(MAX_BUCKETS + 1);
    expect(internals.renderBuckets.has('(other)')).toBe(true);
    expect(internals.apiBuckets.size).toBeLessThanOrEqual(MAX_BUCKETS + 1);
    expect(internals.apiBuckets.has('(other)')).toBe(true);
    expect(internals.transitionBuckets.size).toBeLessThanOrEqual(MAX_BUCKETS + 1);

    // Verbose mode: measures are emitted, rolled/cleared at MAX_MEASURES, and cleared on reset/dispose
    tracker.verbose(true);
    for (let i = 0; i < MAX_MEASURES + 15; i += 1) {
      tracker.onRenderStart({ route: 'chat', settle: i, keep: true });
      clock += 20;
      tracker.onRenderEnd({ route: 'chat', settle: i + 1, keep: true });
    }
    expect(measureSpy).toHaveBeenCalledTimes(MAX_MEASURES + 15);
    expect(clearSpy).toHaveBeenCalled();

    clearSpy.mockClear();
    tracker.reset(false);
    expect(clearSpy).toHaveBeenCalledWith('pdl:render:chat');

    tracker.onRenderStart({ route: 'members', settle: 1, keep: true });
    clock += 20;
    tracker.onRenderEnd({ route: 'members', settle: 2, keep: true });
    clearSpy.mockClear();
    tracker.dispose();
    expect(clearSpy).toHaveBeenCalledWith('pdl:render:members');
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

  it('attributes longtasks to the most recent trigger within 2s and falls back to unknown when stale', () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tracker = new ConsolePerfTracker();

    tracker.onRenderStart({ route: 'chat', settle: 1, keep: true });
    clock += 12;
    tracker.onRenderEnd({ route: 'chat', settle: 2, keep: true });

    clock += 80;
    tracker.recordLongtask('self', 120);

    clock += 2500;
    tracker.recordLongtask('self', 90);

    const summary = tracker.summary(false);
    expect(summary.longtasks.count).toBe(2);
    expect(summary.longtasks.totalBlockingMs).toBe(110);
    expect(summary.longtasks.byTrigger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'render:chat', count: 1, maxMs: 120 }),
        expect.objectContaining({ name: 'unknown', count: 1, maxMs: 90 }),
      ]),
    );

    const events = tracker.recent(5).filter((e) => e.kind === 'longtask');
    expect(events[0].detail).toEqual({ lastKind: 'render', lastName: 'chat', ageMs: 92 });
    expect(events[1].detail).toBeUndefined();

    tracker.reset(false);
    expect(tracker.summary(false).longtasks.byTrigger).toEqual([]);
    tracker.dispose();
  });

  it('records 3-phase input timing breakdown and redacts unified http transport telemetry with bounded buckets', () => {
    const clock = 3000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tracker = new ConsolePerfTracker();

    const textarea = document.createElement('textarea');
    tracker.recordInteraction('keydown', textarea, 95, {
      inputDelayMs: 42.34,
      processingMs: 18.62,
      presentationDelayMs: 34.04,
    });
    const interactionEvent = tracker.recent(5).find((e) => e.kind === 'interaction');
    expect(interactionEvent?.detail).toEqual({
      inputDelayMs: 42.3,
      processingMs: 18.6,
      presentationDelayMs: 34,
    });

    tracker.controller._http(
      'get',
      '/api/threads/thread_SENTINEL_HTTP_ID/messages?token=SENTINEL_HTTP_SECRET',
      210.4,
      503,
      true,
    );
    tracker.controller._http('GET', '/api/labels', 24.5, 200, false);
    const exported = tracker.exportJson();
    expect(exported).not.toContain('SENTINEL_HTTP_ID');
    expect(exported).not.toContain('SENTINEL_HTTP_SECRET');

    const parsed = JSON.parse(exported);
    expect(parsed.summary.http).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'GET /api/threads/:threadId/messages',
          count: 1,
          errors: 1,
          maxMs: 210.4,
        }),
        expect.objectContaining({ name: 'GET /api/labels', count: 1, errors: 0, maxMs: 24.5 }),
      ]),
    );
    const httpEvent = parsed.recent.find((e: { kind: string }) => e.kind === 'http');
    expect(httpEvent).toMatchObject({
      kind: 'http',
      name: 'GET /api/threads/:threadId/messages',
      ms: 210.4,
      detail: { path: '/api/threads/:threadId/messages', status: 503, error: true },
    });

    for (let i = 0; i < MAX_BUCKETS + 20; i += 1) {
      tracker.recordHttp('GET', `/api/ep${i}`, 10, 200, false);
    }
    const internals = tracker as unknown as { httpBuckets: Map<string, unknown> };
    expect(internals.httpBuckets.size).toBeLessThanOrEqual(MAX_BUCKETS + 1);
    expect(internals.httpBuckets.has('(other)')).toBe(true);

    tracker.reset(false);
    expect(tracker.summary(false).http).toEqual([]);
    tracker.dispose();
  });
});
