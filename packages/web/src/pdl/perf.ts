import type { ChatPort } from './types';

export interface RenderHookContext {
  route: string;
  param?: string | null;
  thread?: string | null;
  panel?: string | null;
  settle: number;
  keep: boolean;
  changed?: string[] | null;
}

export interface PerfEvent {
  at: number;
  kind: 'boot' | 'transition' | 'render' | 'api' | 'http' | 'vm' | 'push' | 'longtask' | 'interaction';
  name: string;
  ms: number;
  route: string;
  detail?: Record<string, unknown>;
}

export interface InteractionPhases {
  inputDelayMs: number;
  processingMs: number;
  presentationDelayMs: number;
}

export interface BucketSummary {
  name: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  errors?: number;
}

export interface TransitionSummary {
  route: string;
  count: number;
  avgFirstRenderMs: number;
  maxFirstRenderMs: number;
  avgSettleMs: number;
  maxSettleMs: number;
  avgApiCalls: number;
}

export interface BootSummary {
  stylesMs: number;
  stylesCount: number;
  scriptsMs: number;
  scriptsCount: number;
  startMs: number;
  totalMs: number;
  slowestAssets: Array<{ kind: 'style' | 'script'; path: string; ms: number }>;
}

export interface ConsolePerfSummary {
  boot: BootSummary;
  currentRoute: string;
  renders: {
    total: number;
    painted: number;
    noop: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
    maxPerSec: number;
    byRoute: BucketSummary[];
  };
  transitions: TransitionSummary[];
  pushes: BucketSummary[];
  vms: BucketSummary[];
  api: BucketSummary[];
  http: BucketSummary[];
  longtasks: {
    count: number;
    totalBlockingMs: number;
    maxMs: number;
    byRoute: BucketSummary[];
    byTrigger: BucketSummary[];
  };
  interactions: BucketSummary[];
}

export interface ConsolePerfController {
  summary: (print?: boolean) => ConsolePerfSummary;
  recent: (limit?: number) => PerfEvent[];
  export: () => string;
  reset: (includeBoot?: boolean) => void;
  verbose: (enabled?: boolean) => boolean;
  _renderStart: (ctx: RenderHookContext) => void;
  _renderEnd: (ctx: RenderHookContext) => void;
  _push: (kind: string, ms: number) => void;
  _http: (method: string, path: string, ms: number, status?: number, failed?: boolean) => void;
}

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  samples: number[];
}

interface TransitionBucket {
  count: number;
  firstRenderTotal: number;
  firstRenderMax: number;
  settleTotal: number;
  settleMax: number;
  apiTotal: number;
}

interface ActiveTransition {
  id: number;
  from: string;
  to: string;
  startedAt: number;
  firstRenderMs: number | null;
  pendingGets: number;
  apiCount: number;
  apiPaths: string[];
  renderedAfterStart: boolean;
  settleTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface RenderFrame {
  startedAt: number;
  route: string;
  routeKey: string;
  settleBefore: number;
  keep: boolean;
}

const VERBOSE_KEY = 'pdl:perf:verbose';
const MAX_EVENTS = 500;
const MAX_SAMPLES = 200;
export const MAX_BUCKETS = 64;
export const MAX_MEASURES = 50;
const MAX_BOOT_ASSETS = 200;
const MAX_TRANSITION_API_PATHS = 8;
const OVERFLOW_BUCKET = '(other)';
const SLOW_RENDER_MS = 16;
const VERBOSE_RENDER_MS = 32;
const SLOW_API_MS = 150;
const VERBOSE_API_MS = 300;
const SLOW_VM_MS = 8;
const VERBOSE_VM_MS = 16;
const VERBOSE_TRANSITION_MS = 200;
const SLOW_INTERACTION_MS = 40;
const LONGTASK_ATTRIBUTION_WINDOW_MS = 2000;
const TRANSITION_TIMEOUT_MS = 10_000;

const SAFE_SLUG_RE = /^[a-z][a-z0-9._-]{0,23}$/i;
const ENTITY_PREFIX_RE =
  /^(?:thread|msg|message|cat|p|plugin|exec|run|task|inv|sess|session|work|grp|group|file|doc|art|mem|sig|usr|user|req|attempt)[_-].+/i;
const DYNAMIC_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|\d{5,}|(?=.*\d)(?=.*[a-z])[a-z0-9_-]{12,})$/i;

const round1 = (n: number) => Math.round(n * 10) / 10;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function p95(samples: number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return round1(sorted[idx]);
}

function addSample(map: Map<string, Bucket>, name: string, ms: number, error = false): void {
  const key = map.has(name) || map.size < MAX_BUCKETS ? name : OVERFLOW_BUCKET;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { count: 0, totalMs: 0, maxMs: 0, errors: 0, samples: [] };
    map.set(key, bucket);
  }
  bucket.count += 1;
  bucket.totalMs += ms;
  if (ms > bucket.maxMs) bucket.maxMs = ms;
  if (error) bucket.errors += 1;
  if (bucket.samples.length >= MAX_SAMPLES) bucket.samples.shift();
  bucket.samples.push(ms);
}

function summarizeBuckets(map: Map<string, Bucket>, limit = 15, includeErrors = false): BucketSummary[] {
  return [...map.entries()]
    .map(([name, b]) => ({
      name,
      count: b.count,
      avgMs: round1(b.totalMs / b.count),
      p95Ms: p95(b.samples),
      maxMs: round1(b.maxMs),
      totalMs: round1(b.totalMs),
      ...(includeErrors ? { errors: b.errors } : {}),
    }))
    .sort((a, b) => b.maxMs - a.maxMs || b.totalMs - a.totalMs)
    .slice(0, limit);
}

function sanitizeSlug(raw: string | null | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  if (!SAFE_SLUG_RE.test(trimmed)) return fallback;
  if (ENTITY_PREFIX_RE.test(trimmed) || DYNAMIC_ID_RE.test(trimmed)) return fallback;
  return trimmed;
}

function normalizePathSegment(seg: string): string {
  if (!seg) return '';
  if (/^thread_[a-zA-Z0-9_-]+$/i.test(seg)) return ':threadId';
  if (/^cat[-_][a-zA-Z0-9_-]+$/i.test(seg)) return ':catId';
  if (/^(?:msg|message)[_-][a-zA-Z0-9_-]+$/i.test(seg)) return ':msgId';
  if (/^(?:p|plugin)[_-][a-zA-Z0-9_-]+$/i.test(seg)) return ':pluginId';
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg)) return ':uuid';
  if (ENTITY_PREFIX_RE.test(seg) || DYNAMIC_ID_RE.test(seg)) return ':id';
  if (/^\d+$/.test(seg)) return ':num';
  return SAFE_SLUG_RE.test(seg) ? seg : ':param';
}

export function normalizeApiPath(path: string): string {
  const noHash = path.split('#')[0] ?? path;
  const clean = noHash.split('?')[0] ?? noHash;
  if (!clean) return '/';
  const leading = clean.startsWith('/');
  const parts = clean
    .split('/')
    .filter(Boolean)
    .map((seg) => normalizePathSegment(seg));
  return (leading ? '/' : '') + parts.join('/');
}

function sanitizeChangedKeys(changed?: string[] | null): string[] | undefined {
  if (!changed?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of changed) {
    if (out.length >= 8) break;
    const head = raw.split('|')[0] ?? '';
    let clean: string;
    if (head.startsWith('~vm:')) {
      const vmParts = head
        .slice(4)
        .split(':')
        .slice(0, 2)
        .map((part) => sanitizeSlug(part, ':vm'));
      clean = `~vm:${vmParts.join(':')}`;
    } else if (head.startsWith('~S.') || head.startsWith('~CS.')) {
      const dot = head.indexOf('.');
      const prefix = head.slice(0, dot + 1);
      const top = head.slice(dot + 1).split(/[.:/]/)[0] ?? '';
      clean = `${prefix}${sanitizeSlug(top, ':field')}`;
    } else {
      clean = sanitizeSlug(head.replace(/^~/, ''), ':key');
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.length ? out : undefined;
}

function formatRoute(ctx: Pick<RenderHookContext, 'route' | 'param' | 'panel'>): string {
  const base = sanitizeSlug(ctx.route, 'unknown');
  const withParam = ctx.param ? `${base}:${sanitizeSlug(ctx.param, ':param')}` : base;
  return ctx.panel ? `${withParam}[${sanitizeSlug(ctx.panel, ':panel')}]` : withParam;
}

function formatRouteKey(ctx: Pick<RenderHookContext, 'route' | 'param' | 'thread' | 'panel'>): string {
  return `${ctx.route || ''}|${ctx.param || ''}|${ctx.thread || ''}|${ctx.panel || ''}`;
}

export function describeTarget(target: EventTarget | null): string {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return 'unknown';
  const el = target as Element;
  const tag = sanitizeSlug(el.tagName.toLowerCase(), 'el');
  const act = el.getAttribute?.('data-act');
  if (act) return `${tag}[data-act="${sanitizeSlug(act, ':act')}"]`;
  const view = el.getAttribute?.('data-view');
  if (view) return `${tag}[data-view="${sanitizeSlug(view, ':view')}"]`;
  return tag;
}

function readVerboseFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(VERBOSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeVerboseFlag(enabled: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (enabled) window.localStorage.setItem(VERBOSE_KEY, '1');
    else window.localStorage.removeItem(VERBOSE_KEY);
  } catch {
    // Ignore private-mode storage errors
  }
}

export class ConsolePerfTracker {
  private bootAssets: Array<{ kind: 'style' | 'script'; path: string; ms: number }> = [];
  private bootStylesMs = 0;
  private bootStylesCount = 0;
  private bootScriptsMs = 0;
  private bootScriptsCount = 0;
  private bootStartMs = 0;
  private bootTotalMs = 0;

  private events: PerfEvent[] = [];
  private renderBuckets = new Map<string, Bucket>();
  private renderAllBucket: Bucket = { count: 0, totalMs: 0, maxMs: 0, errors: 0, samples: [] };
  private renderPainted = 0;
  private renderNoop = 0;
  private renderWindowTimestamps: number[] = [];
  private maxRendersPerSec = 0;
  private renderStack: RenderFrame[] = [];

  private transitionBuckets = new Map<string, TransitionBucket>();
  private activeTransition: ActiveTransition | null = null;
  private nextTransitionId = 1;
  private lastRoute = 'boot';
  private lastRouteKey = '';

  private pushBuckets = new Map<string, Bucket>();
  private vmBuckets = new Map<string, Bucket>();
  private apiBuckets = new Map<string, Bucket>();
  private httpBuckets = new Map<string, Bucket>();
  private longtaskBuckets = new Map<string, Bucket>();
  private longtaskTriggerBuckets = new Map<string, Bucket>();
  private longtaskCount = 0;
  private longtaskBlockingMs = 0;
  private longtaskMaxMs = 0;
  private interactionBuckets = new Map<string, Bucket>();
  private lastTrigger: { kind: string; name: string; at: number } | null = null;

  private observers: PerformanceObserver[] = [];
  private measureNames = new Set<string>();
  private measureCount = 0;
  private verboseEnabled = readVerboseFlag();
  private wrappedPorts = new WeakMap<ChatPort, ChatPort>();

  readonly controller: ConsolePerfController;

  constructor() {
    this.controller = {
      summary: (print = true) => this.summary(print),
      recent: (limit = 30) => this.recent(limit),
      export: () => this.exportJson(),
      reset: (includeBoot = false) => this.reset(includeBoot),
      verbose: (enabled?: boolean) => this.verbose(enabled),
      _renderStart: (ctx) => this.onRenderStart(ctx),
      _renderEnd: (ctx) => this.onRenderEnd(ctx),
      _push: (kind, ms) => this.recordPush(kind, ms),
      _http: (method, path, ms, status, failed) => this.recordHttp(method, path, ms, status, failed),
    };
  }

  private noteTrigger(kind: string, name: string): void {
    this.lastTrigger = { kind, name, at: nowMs() };
  }

  private pushEvent(event: PerfEvent, logVerbose = false): void {
    if (this.events.length >= MAX_EVENTS) this.events.shift();
    this.events.push(event);
    if (logVerbose && this.verboseEnabled && typeof console !== 'undefined') {
      console.warn(`[pdl-perf] ${event.kind} ${event.name} ${round1(event.ms)}ms (${event.route})`, event.detail ?? '');
    }
  }

  recordBootAsset(kind: 'style' | 'script', path: string, ms: number): void {
    const rounded = round1(ms);
    if (this.bootAssets.length < MAX_BOOT_ASSETS) {
      const cleanPath = (path.split('?')[0] ?? path).split('#')[0] ?? path;
      this.bootAssets.push({ kind, path: cleanPath, ms: rounded });
    }
    if (kind === 'style') {
      this.bootStylesMs += ms;
      this.bootStylesCount += 1;
    } else {
      this.bootScriptsMs += ms;
      this.bootScriptsCount += 1;
    }
  }

  recordBootStart(ms: number): void {
    this.bootStartMs = ms;
  }

  finishBoot(totalMs: number): void {
    this.bootTotalMs = totalMs;
    this.pushEvent(
      {
        at: Date.now(),
        kind: 'boot',
        name: 'console.boot',
        ms: round1(totalMs),
        route: this.lastRoute,
        detail: {
          stylesMs: round1(this.bootStylesMs),
          stylesCount: this.bootStylesCount,
          scriptsMs: round1(this.bootScriptsMs),
          scriptsCount: this.bootScriptsCount,
          startMs: round1(this.bootStartMs),
        },
      },
      totalMs >= VERBOSE_TRANSITION_MS,
    );
  }

  onRenderStart(ctx: RenderHookContext): void {
    const t = nowMs();
    const route = formatRoute(ctx);
    const routeKey = formatRouteKey(ctx);
    this.noteTrigger('render', route);
    this.renderStack.push({
      startedAt: t,
      route,
      routeKey,
      settleBefore: ctx.settle,
      keep: ctx.keep,
    });
    this.updateRoute(route, routeKey, t);
  }

  private updateRoute(route: string, routeKey: string, startedAt: number): void {
    if (this.lastRouteKey && routeKey !== this.lastRouteKey) {
      this.beginTransition(this.lastRoute, route, startedAt);
    }
    this.lastRoute = route;
    this.lastRouteKey = routeKey;
  }

  private recordRenderSample(route: string, ms: number, painted: boolean, end: number): void {
    this.renderAllBucket.count += 1;
    this.renderAllBucket.totalMs += ms;
    if (ms > this.renderAllBucket.maxMs) this.renderAllBucket.maxMs = ms;
    if (this.renderAllBucket.samples.length >= MAX_SAMPLES) this.renderAllBucket.samples.shift();
    this.renderAllBucket.samples.push(ms);
    if (painted) this.renderPainted += 1;
    else this.renderNoop += 1;
    addSample(this.renderBuckets, route, ms);

    this.renderWindowTimestamps.push(end);
    const cutoff = end - 1000;
    while (this.renderWindowTimestamps.length && this.renderWindowTimestamps[0] < cutoff) {
      this.renderWindowTimestamps.shift();
    }
    if (this.renderWindowTimestamps.length > this.maxRendersPerSec) {
      this.maxRendersPerSec = this.renderWindowTimestamps.length;
    }
  }

  onRenderEnd(ctx: RenderHookContext): void {
    const frame = this.renderStack.pop();
    if (!frame) return;
    const end = nowMs();
    const ms = Math.max(0, end - frame.startedAt);
    const painted = ctx.settle !== frame.settleBefore;
    const route = formatRoute(ctx);
    this.updateRoute(route, formatRouteKey(ctx), frame.startedAt);
    this.recordRenderSample(route, ms, painted, end);

    if (ms >= SLOW_RENDER_MS) {
      this.emitMeasure(`pdl:render:${route}`, frame.startedAt, end);
      this.pushEvent(
        {
          at: Date.now(),
          kind: 'render',
          name: painted ? 'render.paint' : 'render.noop',
          ms: round1(ms),
          route,
          detail: {
            keep: frame.keep,
            changed: sanitizeChangedKeys(ctx.changed),
          },
        },
        ms >= VERBOSE_RENDER_MS,
      );
    }

    const active = this.activeTransition;
    if (active && !active.settled && active.to === route) {
      if (active.firstRenderMs === null) active.firstRenderMs = ms;
      active.renderedAfterStart = true;
      this.maybeScheduleSettle(active);
    }
  }

  private beginTransition(from: string, to: string, startedAt: number): void {
    if (this.activeTransition && !this.activeTransition.settled) {
      this.completeTransition(this.activeTransition, true);
    }
    const transition: ActiveTransition = {
      id: this.nextTransitionId++,
      from,
      to,
      startedAt,
      firstRenderMs: null,
      pendingGets: 0,
      apiCount: 0,
      apiPaths: [],
      renderedAfterStart: false,
      settleTimer: setTimeout(() => {
        if (this.activeTransition?.id === transition.id && !transition.settled) {
          this.completeTransition(transition, true);
        }
      }, TRANSITION_TIMEOUT_MS),
      settled: false,
    };
    this.activeTransition = transition;
  }

  private maybeScheduleSettle(transition: ActiveTransition): void {
    if (transition.settled || !transition.renderedAfterStart || transition.pendingGets > 0) return;
    const finish = () => {
      if (this.activeTransition?.id !== transition.id || transition.settled) return;
      if (transition.pendingGets > 0) return;
      this.completeTransition(transition, false);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => finish());
    } else {
      queueMicrotask(finish);
    }
  }

  private completeTransition(transition: ActiveTransition, timedOut: boolean): void {
    if (transition.settled) return;
    transition.settled = true;
    if (transition.settleTimer) {
      clearTimeout(transition.settleTimer);
      transition.settleTimer = null;
    }
    const settleMs = Math.max(0, nowMs() - transition.startedAt);
    const firstRenderMs = transition.firstRenderMs ?? 0;
    const bucketKey =
      this.transitionBuckets.has(transition.to) || this.transitionBuckets.size < MAX_BUCKETS
        ? transition.to
        : OVERFLOW_BUCKET;
    let bucket = this.transitionBuckets.get(bucketKey);
    if (!bucket) {
      bucket = { count: 0, firstRenderTotal: 0, firstRenderMax: 0, settleTotal: 0, settleMax: 0, apiTotal: 0 };
      this.transitionBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    bucket.firstRenderTotal += firstRenderMs;
    if (firstRenderMs > bucket.firstRenderMax) bucket.firstRenderMax = firstRenderMs;
    bucket.settleTotal += settleMs;
    if (settleMs > bucket.settleMax) bucket.settleMax = settleMs;
    bucket.apiTotal += transition.apiCount;

    this.pushEvent(
      {
        at: Date.now(),
        kind: 'transition',
        name: `${transition.from} -> ${transition.to}`,
        ms: round1(settleMs),
        route: transition.to,
        detail: {
          firstRenderMs: round1(firstRenderMs),
          apiCount: transition.apiCount,
          apiPaths: transition.apiPaths.slice(0, 8),
          ...(timedOut ? { timedOut: true } : {}),
        },
      },
      settleMs >= VERBOSE_TRANSITION_MS,
    );
    if (this.activeTransition?.id === transition.id) this.activeTransition = null;
  }

  recordPush(kind: string, ms: number): void {
    const safeKind = sanitizeSlug(kind, 'push');
    this.noteTrigger('push', safeKind);
    addSample(this.pushBuckets, safeKind, ms);
    if (ms >= SLOW_RENDER_MS) {
      this.pushEvent(
        {
          at: Date.now(),
          kind: 'push',
          name: safeKind,
          ms: round1(ms),
          route: this.lastRoute,
        },
        ms >= VERBOSE_RENDER_MS,
      );
    }
  }

  recordVm(name: string, ms: number): void {
    this.noteTrigger('vm', name);
    addSample(this.vmBuckets, name, ms);
    if (ms >= SLOW_VM_MS) {
      this.pushEvent(
        {
          at: Date.now(),
          kind: 'vm',
          name,
          ms: round1(ms),
          route: this.lastRoute,
        },
        ms >= VERBOSE_VM_MS,
      );
    }
  }

  recordHttp(method: string, path: string, ms: number, status = 0, failed = false): void {
    const safeMethod = sanitizeSlug(method.toUpperCase(), 'HTTP');
    const safePath = normalizeApiPath(path);
    const key = `${safeMethod} ${safePath}`;
    this.noteTrigger('http', key);
    addSample(this.httpBuckets, key, ms, failed);
    if (failed || ms >= SLOW_API_MS) {
      this.pushEvent(
        {
          at: Date.now(),
          kind: 'http',
          name: key,
          ms: round1(ms),
          route: this.lastRoute,
          detail: {
            path: safePath,
            ...(status ? { status } : {}),
            ...(failed ? { error: true } : {}),
          },
        },
        failed || ms >= VERBOSE_API_MS,
      );
    }
  }

  private finishPortCall(
    key: string,
    route: string,
    ms: number,
    failed: boolean,
    safePath?: string,
    transition?: ActiveTransition | null,
  ): void {
    addSample(this.apiBuckets, key, ms, failed);
    if (ms >= SLOW_API_MS || failed) {
      const detail =
        safePath !== undefined
          ? { path: safePath, ...(failed ? { error: true } : {}) }
          : failed
            ? { error: true }
            : undefined;
      this.pushEvent(
        {
          at: Date.now(),
          kind: 'api',
          name: key,
          ms: round1(ms),
          route,
          detail,
        },
        ms >= VERBOSE_API_MS,
      );
    }
    if (transition) {
      transition.pendingGets = Math.max(0, transition.pendingGets - 1);
      this.maybeScheduleSettle(transition);
    }
  }

  private trackPortCall<R>(key: string, run: () => R, options?: { safePath?: string; attachTransition?: boolean }): R {
    const t0 = nowMs();
    const route = this.lastRoute;
    this.noteTrigger('api', key);
    const transition =
      options?.attachTransition && this.activeTransition && !this.activeTransition.settled
        ? this.activeTransition
        : null;
    if (transition && options?.safePath) {
      transition.pendingGets += 1;
      transition.apiCount += 1;
      if (transition.apiPaths.length < MAX_TRANSITION_API_PATHS) {
        transition.apiPaths.push(options.safePath);
      }
    }
    const done = (failed: boolean) => {
      this.finishPortCall(key, route, Math.max(0, nowMs() - t0), failed, options?.safePath, transition);
    };
    let result: R;
    try {
      result = run();
    } catch (err) {
      done(true);
      throw err;
    }
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (val) => {
          done(false);
          return val;
        },
        (err) => {
          done(true);
          throw err;
        },
      ) as unknown as R;
    }
    done(false);
    return result;
  }

  instrumentPort(port: ChatPort): ChatPort {
    const existing = this.wrappedPorts.get(port);
    if (existing) return existing;
    const proxy = new Proxy(port, {
      get: (target, prop, receiver) => {
        if (prop === 'get') {
          return (path: string, params?: Record<string, string>, options?: { afterCurrentGet?: boolean }) => {
            const safePath = normalizeApiPath(path);
            return this.trackPortCall(`GET ${safePath}`, () => target.get(path, params, options), {
              safePath,
              attachTransition: true,
            });
          };
        }
        if (prop === 'post') {
          return (path: string, params: Record<string, string>, body: unknown) => {
            const safePath = normalizeApiPath(path);
            return this.trackPortCall(`POST ${safePath}`, () => target.post(path, params, body), {
              safePath,
            });
          };
        }
        if (prop === 'action') {
          return (name: string, args: Record<string, string>, el?: HTMLElement) =>
            this.trackPortCall(`ACT ${sanitizeSlug(name, ':act')}`, () => target.action(name, args, el));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.wrappedPorts.set(port, proxy);
    this.wrappedPorts.set(proxy, proxy);
    return proxy;
  }

  instrumentChatModels<T extends (...args: never[]) => unknown>(fn: T): T {
    const record = (slice: string, ms: number) => this.recordVm(`chatModels:${sanitizeSlug(slice, ':slice')}`, ms);
    const raw = fn as unknown as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const t0 = nowMs();
      const slice = typeof args[3] === 'string' && args[3] ? args[3] : 'all';
      try {
        return raw.apply(this, args);
      } finally {
        record(slice, Math.max(0, nowMs() - t0));
      }
    };
    return wrapped as unknown as T;
  }

  instrumentClowderChat(chat: Window['clowderChat']): void {
    const origUpdate = chat.update;
    chat.update = (port?: ChatPort) => {
      const t0 = nowMs();
      try {
        return origUpdate(port ? this.instrumentPort(port) : undefined);
      } finally {
        this.recordPush('update', Math.max(0, nowMs() - t0));
      }
    };
    const origPushChat = chat.pushChat;
    chat.pushChat = (data) => {
      const t0 = nowMs();
      try {
        return origPushChat(data);
      } finally {
        this.recordPush('pushChat', Math.max(0, nowMs() - t0));
      }
    };
    const origPushSidebar = chat.pushSidebar;
    chat.pushSidebar = (data) => {
      const t0 = nowMs();
      try {
        return origPushSidebar(data);
      } finally {
        this.recordPush('pushSidebar', Math.max(0, nowMs() - t0));
      }
    };
    const origPushProject = chat.pushProject;
    chat.pushProject = (data) => {
      const t0 = nowMs();
      try {
        return origPushProject(data);
      } finally {
        this.recordPush('pushProject', Math.max(0, nowMs() - t0));
      }
    };
  }

  attachObservers(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    if (supported.includes('longtask')) {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.recordLongtask(entry.name || 'self', entry.duration);
          }
        });
        obs.observe({ type: 'longtask', buffered: true });
        this.observers.push(obs);
      } catch {
        // Unsupported in this browser/runtime
      }
    }
    if (supported.includes('event')) {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ev = entry as PerformanceEventTiming;
            let phases: InteractionPhases | undefined;
            if (
              typeof ev.processingStart === 'number' &&
              typeof ev.processingEnd === 'number' &&
              ev.processingStart >= ev.startTime &&
              ev.processingEnd >= ev.processingStart
            ) {
              phases = {
                inputDelayMs: round1(Math.max(0, ev.processingStart - ev.startTime)),
                processingMs: round1(Math.max(0, ev.processingEnd - ev.processingStart)),
                presentationDelayMs: round1(Math.max(0, ev.duration - (ev.processingEnd - ev.startTime))),
              };
            }
            this.recordInteraction(ev.name, ev.target ?? null, ev.duration, phases);
          }
        });
        obs.observe({
          type: 'event',
          buffered: false,
          durationThreshold: SLOW_INTERACTION_MS,
        } as PerformanceObserverInit);
        this.observers.push(obs);
      } catch {
        // Unsupported in this browser/runtime
      }
    }
  }

  recordLongtask(name: string, ms: number): void {
    this.longtaskCount += 1;
    this.longtaskBlockingMs += Math.max(0, ms - 50);
    if (ms > this.longtaskMaxMs) this.longtaskMaxMs = ms;
    addSample(this.longtaskBuckets, this.lastRoute, ms);
    const now = nowMs();
    const trig =
      this.lastTrigger && now - this.lastTrigger.at <= LONGTASK_ATTRIBUTION_WINDOW_MS ? this.lastTrigger : null;
    const triggerKey = trig ? `${trig.kind}:${trig.name}` : 'unknown';
    addSample(this.longtaskTriggerBuckets, triggerKey, ms);
    const detail = trig
      ? { lastKind: trig.kind, lastName: trig.name, ageMs: round1(Math.max(0, now - trig.at)) }
      : undefined;
    this.pushEvent(
      {
        at: Date.now(),
        kind: 'longtask',
        name: sanitizeSlug(name, 'self'),
        ms: round1(ms),
        route: this.lastRoute,
        ...(detail ? { detail } : {}),
      },
      true,
    );
  }

  recordInteraction(
    eventName: string,
    target: EventTarget | null,
    durationMs: number,
    phases?: InteractionPhases,
  ): void {
    if (durationMs < SLOW_INTERACTION_MS) return;
    const name = `${sanitizeSlug(eventName, 'event')} ${describeTarget(target)}`;
    this.noteTrigger('interaction', name);
    addSample(this.interactionBuckets, name, durationMs);
    const detail = phases
      ? {
          inputDelayMs: round1(Math.max(0, phases.inputDelayMs)),
          processingMs: round1(Math.max(0, phases.processingMs)),
          presentationDelayMs: round1(Math.max(0, phases.presentationDelayMs)),
        }
      : undefined;
    this.pushEvent(
      {
        at: Date.now(),
        kind: 'interaction',
        name,
        ms: round1(durationMs),
        route: this.lastRoute,
        ...(detail ? { detail } : {}),
      },
      durationMs >= 100,
    );
  }

  private clearMeasures(): void {
    if (typeof performance !== 'undefined' && typeof performance.clearMeasures === 'function') {
      for (const name of this.measureNames) {
        try {
          performance.clearMeasures(name);
        } catch {
          // Ignore unsupported runtime implementations
        }
      }
    }
    this.measureNames.clear();
    this.measureCount = 0;
  }

  dispose(): void {
    for (const obs of this.observers) obs.disconnect();
    this.observers = [];
    if (this.activeTransition?.settleTimer) clearTimeout(this.activeTransition.settleTimer);
    this.activeTransition = null;
    this.clearMeasures();
  }

  private emitMeasure(name: string, start: number, end: number): void {
    if (!this.verboseEnabled) return;
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
    if (this.measureCount >= MAX_MEASURES) this.clearMeasures();
    try {
      performance.measure(name, { start, end });
      this.measureNames.add(name);
      this.measureCount += 1;
    } catch {
      // Ignore browsers that only accept mark names
    }
  }

  summary(print = true): ConsolePerfSummary {
    const out: ConsolePerfSummary = {
      boot: {
        stylesMs: round1(this.bootStylesMs),
        stylesCount: this.bootStylesCount,
        scriptsMs: round1(this.bootScriptsMs),
        scriptsCount: this.bootScriptsCount,
        startMs: round1(this.bootStartMs),
        totalMs: round1(this.bootTotalMs),
        slowestAssets: [...this.bootAssets].sort((a, b) => b.ms - a.ms).slice(0, 8),
      },
      currentRoute: this.lastRoute,
      renders: {
        total: this.renderAllBucket.count,
        painted: this.renderPainted,
        noop: this.renderNoop,
        avgMs: this.renderAllBucket.count ? round1(this.renderAllBucket.totalMs / this.renderAllBucket.count) : 0,
        p95Ms: p95(this.renderAllBucket.samples),
        maxMs: round1(this.renderAllBucket.maxMs),
        maxPerSec: this.maxRendersPerSec,
        byRoute: summarizeBuckets(this.renderBuckets, 10),
      },
      transitions: [...this.transitionBuckets.entries()]
        .map(([route, b]) => ({
          route,
          count: b.count,
          avgFirstRenderMs: round1(b.firstRenderTotal / b.count),
          maxFirstRenderMs: round1(b.firstRenderMax),
          avgSettleMs: round1(b.settleTotal / b.count),
          maxSettleMs: round1(b.settleMax),
          avgApiCalls: round1(b.apiTotal / b.count),
        }))
        .sort((a, b) => b.maxSettleMs - a.maxSettleMs)
        .slice(0, 15),
      pushes: summarizeBuckets(this.pushBuckets, 10),
      vms: summarizeBuckets(this.vmBuckets, 15),
      api: summarizeBuckets(this.apiBuckets, 20, true),
      http: summarizeBuckets(this.httpBuckets, 20, true),
      longtasks: {
        count: this.longtaskCount,
        totalBlockingMs: round1(this.longtaskBlockingMs),
        maxMs: round1(this.longtaskMaxMs),
        byRoute: summarizeBuckets(this.longtaskBuckets, 10),
        byTrigger: summarizeBuckets(this.longtaskTriggerBuckets, 10),
      },
      interactions: summarizeBuckets(this.interactionBuckets, 10),
    };
    if (print && typeof console !== 'undefined') {
      printPerfSummary(out);
    }
    return out;
  }

  recent(limit = 30): PerfEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  exportJson(): string {
    return JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        path: typeof location !== 'undefined' ? normalizeApiPath(location.pathname) : '',
        summary: this.summary(false),
        recent: this.recent(100),
      },
      null,
      2,
    );
  }

  reset(includeBoot = false): void {
    this.events = [];
    this.clearMeasures();
    this.renderBuckets.clear();
    this.renderAllBucket = { count: 0, totalMs: 0, maxMs: 0, errors: 0, samples: [] };
    this.renderPainted = 0;
    this.renderNoop = 0;
    this.renderWindowTimestamps = [];
    this.maxRendersPerSec = 0;
    this.transitionBuckets.clear();
    if (this.activeTransition?.settleTimer) clearTimeout(this.activeTransition.settleTimer);
    this.activeTransition = null;
    this.pushBuckets.clear();
    this.vmBuckets.clear();
    this.apiBuckets.clear();
    this.httpBuckets.clear();
    this.longtaskBuckets.clear();
    this.longtaskTriggerBuckets.clear();
    this.longtaskCount = 0;
    this.longtaskBlockingMs = 0;
    this.longtaskMaxMs = 0;
    this.interactionBuckets.clear();
    this.lastTrigger = null;
    if (includeBoot) {
      this.bootAssets = [];
      this.bootStylesMs = 0;
      this.bootStylesCount = 0;
      this.bootScriptsMs = 0;
      this.bootScriptsCount = 0;
      this.bootStartMs = 0;
      this.bootTotalMs = 0;
    }
  }

  verbose(enabled?: boolean): boolean {
    if (typeof enabled === 'boolean') {
      this.verboseEnabled = enabled;
      writeVerboseFlag(enabled);
      if (!enabled) this.clearMeasures();
    }
    return this.verboseEnabled;
  }
}

function printTable(label: string | null, rows: unknown[]): void {
  if (!rows.length) return;
  if (label) console.log(label);
  console.table(rows);
}

function printPerfSummary(out: ConsolePerfSummary): void {
  console.group(`[pdl-perf] summary (route: ${out.currentRoute})`);
  console.log('boot:', {
    totalMs: out.boot.totalMs,
    stylesMs: out.boot.stylesMs,
    scriptsMs: out.boot.scriptsMs,
    startMs: out.boot.startMs,
  });
  printTable(null, out.boot.slowestAssets);
  printTable('transitions:', out.transitions);
  console.log('renders:', {
    total: out.renders.total,
    painted: out.renders.painted,
    noop: out.renders.noop,
    avgMs: out.renders.avgMs,
    p95Ms: out.renders.p95Ms,
    maxMs: out.renders.maxMs,
    maxPerSec: out.renders.maxPerSec,
  });
  printTable(null, out.renders.byRoute);
  printTable('pushes:', out.pushes);
  printTable('vms:', out.vms);
  printTable('api:', out.api);
  printTable('http:', out.http);
  if (out.longtasks.count) {
    console.log('longtasks:', {
      count: out.longtasks.count,
      totalBlockingMs: out.longtasks.totalBlockingMs,
      maxMs: out.longtasks.maxMs,
    });
    console.table(out.longtasks.byRoute);
    printTable('longtasks by trigger:', out.longtasks.byTrigger);
  }
  printTable('slow interactions:', out.interactions);
  console.groupEnd();
}

let singleton: ConsolePerfTracker | null = null;

export function installConsolePerf(): ConsolePerfTracker {
  if (!singleton) {
    singleton = new ConsolePerfTracker();
    singleton.attachObservers();
  }
  if (typeof window !== 'undefined') {
    window.__pdlPerf = singleton.controller;
  }
  return singleton;
}
