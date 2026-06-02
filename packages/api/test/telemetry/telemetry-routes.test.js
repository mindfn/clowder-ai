/**
 * F153 Phase E: Telemetry API route tests.
 *
 * Covers:
 * - AC-E5: all endpoints require session auth → 401 without session
 * - AC-E4: invocationId query is HMAC'd before matching
 * - GET /api/telemetry/traces — filtering and pagination
 * - GET /api/telemetry/traces/stats — ring buffer stats
 * - GET /api/telemetry/metrics — metrics text proxy
 * - GET /api/telemetry/health — health aggregation
 * - 503 when trace store is null (OTel disabled)
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';

const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');
const { MetricsSnapshotStore } = await import('../../dist/infrastructure/telemetry/metrics-snapshot-store.js');
const { telemetryRoutes } = await import('../../dist/routes/telemetry.js');
const { hmacId } = await import('../../dist/infrastructure/telemetry/hmac.js');
const { sessionAuthPlugin, sessionRoute } = await import('../../dist/infrastructure/session-auth.js');

/** Build a test Fastify app with telemetry routes registered. */
async function buildApp(opts = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  await app.register(telemetryRoutes, {
    traceStore: opts.traceStore ?? new LocalTraceStore({ maxSpans: 100 }),
    getMetricsText: opts.getMetricsText ?? undefined,
    ...opts,
  });
  return app;
}

/** Get a session cookie from the test app. */
async function getSessionCookie(app) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { 'x-cat-cafe-user': 'test-user' },
  });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  // Extract cookie value from set-cookie header
  const match = String(setCookie).match(/cat_cafe_session=([^;]+)/);
  return match ? `cat_cafe_session=${match[1]}` : '';
}

/** Make a DTO for test fixtures. */
function makeDTO(overrides = {}) {
  return {
    traceId: 'trace-aaa',
    spanId: 'span-bbb',
    name: 'test.span',
    kind: 0,
    startTimeMs: Date.now() - 100,
    endTimeMs: Date.now(),
    durationMs: 100,
    status: { code: 0 },
    attributes: {},
    events: [],
    storedAt: Date.now(),
    ...overrides,
  };
}

// ─── AC-E5: Session auth required ───

test('GET /api/telemetry/traces returns 401 without session', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/traces' });
  assert.equal(res.statusCode, 401);
  assert.ok(JSON.parse(res.body).error);
  app.close();
});

test('GET /api/telemetry/traces/stats returns 401 without session', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/traces/stats' });
  assert.equal(res.statusCode, 401);
  app.close();
});

test('GET /api/telemetry/metrics returns 401 without session', async () => {
  const app = await buildApp({ getMetricsText: async () => '' });
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/metrics' });
  assert.equal(res.statusCode, 401);
  app.close();
});

test('GET /api/telemetry/health returns 401 without session', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/health' });
  assert.equal(res.statusCode, 401);
  app.close();
});

// ─── Trace queries ───

test('GET /api/telemetry/traces returns spans with session', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ traceId: 'my-trace' }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.spans[0].traceId, 'my-trace');
  app.close();
});

test('GET /api/telemetry/traces filters by traceId', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ traceId: 'aaa' }));
  store.add(makeDTO({ traceId: 'bbb' }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?traceId=aaa',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.spans[0].traceId, 'aaa');
  app.close();
});

test('GET /api/telemetry/traces HMAC-converts invocationId before matching (AC-E4)', async () => {
  const rawInvId = 'raw-invocation-abc';
  const hmacInvId = hmacId(rawInvId);

  const store = new LocalTraceStore({ maxSpans: 100 });
  // Store has HMAC'd invocationId (as placed by RedactingSpanProcessor)
  store.add(makeDTO({ attributes: { invocationId: hmacInvId } }));
  store.add(makeDTO({ attributes: { invocationId: 'other-hmac' } }));

  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  // Query with RAW invocationId — route should HMAC it before matching
  const res = await app.inject({
    method: 'GET',
    url: `/api/telemetry/traces?invocationId=${rawInvId}`,
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.spans[0].attributes.invocationId, hmacInvId);
  app.close();
});

test('GET /api/telemetry/traces filters by catId (Class D passthrough)', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ attributes: { 'agent.id': 'ragdoll' } }));
  store.add(makeDTO({ attributes: { 'agent.id': 'maine-coon' } }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?catId=ragdoll',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.spans[0].attributes['agent.id'], 'ragdoll');
  app.close();
});

test('GET /api/telemetry/traces respects limit param', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  for (let i = 0; i < 10; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?limit=3',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 3);
  app.close();
});

test('GET /api/telemetry/traces caps limit at 500', async () => {
  const store = new LocalTraceStore({ maxSpans: 1000 });
  for (let i = 0; i < 600; i++) store.add(makeDTO({ spanId: `s-${i}` }));
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces?limit=9999',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 500);
  app.close();
});

// ─── 503 when OTel disabled ───

test('GET /api/telemetry/traces returns 503 when store is null', async () => {
  const app = await buildApp({ traceStore: null });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 503);
  app.close();
});

// ─── Stats ───

test('GET /api/telemetry/traces/stats returns buffer info', async () => {
  const store = new LocalTraceStore({ maxSpans: 500, maxAgeMs: 3600000 });
  store.add(makeDTO());
  const app = await buildApp({ traceStore: store });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/traces/stats',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.spanCount, 1);
  assert.equal(body.maxSpans, 500);
  app.close();
});

// ─── Metrics ───

test('GET /api/telemetry/metrics returns text from registry', async () => {
  const app = await buildApp({
    getMetricsText: async () => '# HELP cat_cafe_invocation_duration\ncat_cafe_invocation_duration_sum 42\n',
  });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/metrics',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type'].includes('text/plain'));
  assert.ok(res.body.includes('cat_cafe_invocation_duration'));
  app.close();
});

test('GET /api/telemetry/metrics returns 503 when no reader', async () => {
  const app = await buildApp({ getMetricsText: undefined });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/metrics',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 503);
  app.close();
});

// ─── Health ───

test('GET /api/telemetry/health returns full health contract', async () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 10 });
  snapshotStore.add({ timestamp: Date.now(), metrics: { x: 1 } });
  const checkReadiness = async () => ({
    status: 'ready',
    checks: { redis: { ok: true, ms: 2 }, sqlite: { ok: true, ms: 1 } },
  });
  const app = await buildApp({ traceStore: store, metricsSnapshotStore: snapshotStore, checkReadiness });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/health',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'healthy');
  assert.ok(typeof body.uptime === 'number');
  assert.ok(body.traceStore !== undefined);
  assert.ok(body.metricsSnapshotStore !== undefined);
  assert.equal(body.metricsSnapshotStore.snapshotCount, 1);
  assert.ok(typeof body.timestamp === 'number');
  assert.equal(body.readiness.status, 'ready');
  assert.ok(body.readiness.checks.redis.ok);
  assert.ok(body.readiness.checks.sqlite.ok);
  assert.ok(body.errorRate === null || typeof body.errorRate === 'number');
  app.close();
});

test('GET /api/telemetry/health returns 503 when readiness is degraded', async () => {
  const checkReadiness = async () => ({
    status: 'degraded',
    checks: { redis: { ok: false, ms: 0, error: 'connection refused' } },
  });
  const app = await buildApp({ checkReadiness });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/health',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'degraded');
  assert.ok(Array.isArray(body.reasons));
  assert.ok(body.reasons.includes('readiness_degraded'));
  app.close();
});

// ─── F167 resilience: stores=null must be visible when OTel should be on ───
//
// Regression for 2026-06-01..06-02 eval:a2a verdicts: when telemetry init
// silently fails (e.g. missing TELEMETRY_HMAC_SALT under profile-driven
// startup) the f167-runtime-eval source adapter goes dark, but /health
// previously still returned 200 healthy because it never inspected the
// stores. New contract: OTel-on + null stores ⇒ degraded + 503 with reason.

test('GET /api/telemetry/health returns 503 when traceStore is null while OTel is enabled', async () => {
  const prev = process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_SDK_DISABLED;
  try {
    const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 10 });
    const app = await buildApp({ traceStore: null, metricsSnapshotStore: snapshotStore });
    const cookie = await getSessionCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/telemetry/health',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'degraded');
    assert.equal(body.otelEnabled, true);
    assert.ok(Array.isArray(body.reasons));
    assert.ok(body.reasons.includes('telemetry_stores_unavailable'));
    app.close();
  } finally {
    if (prev !== undefined) process.env.OTEL_SDK_DISABLED = prev;
  }
});

test('GET /api/telemetry/health returns 503 when metricsSnapshotStore is null while OTel is enabled', async () => {
  const prev = process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_SDK_DISABLED;
  try {
    const traceStore = new LocalTraceStore({ maxSpans: 100 });
    const app = await buildApp({ traceStore, metricsSnapshotStore: null });
    const cookie = await getSessionCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/telemetry/health',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'degraded');
    assert.equal(body.otelEnabled, true);
    assert.ok(body.reasons.includes('telemetry_stores_unavailable'));
    app.close();
  } finally {
    if (prev !== undefined) process.env.OTEL_SDK_DISABLED = prev;
  }
});

test('GET /api/telemetry/health stays healthy when OTel is explicitly disabled and stores are null', async () => {
  const prev = process.env.OTEL_SDK_DISABLED;
  process.env.OTEL_SDK_DISABLED = 'true';
  try {
    const app = await buildApp({ traceStore: null, metricsSnapshotStore: null });
    const cookie = await getSessionCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/telemetry/health',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'healthy');
    assert.equal(body.otelEnabled, false);
    assert.deepEqual(body.reasons, []);
    app.close();
  } finally {
    if (prev === undefined) delete process.env.OTEL_SDK_DISABLED;
    else process.env.OTEL_SDK_DISABLED = prev;
  }
});

// Regression for codex review of 39d64d73b: the prior implementation used
// `!process.env.OTEL_SDK_DISABLED`, which treated any non-empty value
// (including the very common `OTEL_SDK_DISABLED=false`) as disabled and
// re-muted the alarms this fix was meant to surface. The route now goes
// through isOtelSdkEnabled() so only the literal 'true' disables OTel,
// matching init.ts. This test pins that contract.
test('GET /api/telemetry/health returns 503 when OTEL_SDK_DISABLED=false and stores are null', async () => {
  const prev = process.env.OTEL_SDK_DISABLED;
  process.env.OTEL_SDK_DISABLED = 'false';
  try {
    const app = await buildApp({ traceStore: null, metricsSnapshotStore: null });
    const cookie = await getSessionCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/telemetry/health',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'degraded');
    assert.equal(body.otelEnabled, true);
    assert.ok(body.reasons.includes('telemetry_stores_unavailable'));
    app.close();
  } finally {
    if (prev === undefined) delete process.env.OTEL_SDK_DISABLED;
    else process.env.OTEL_SDK_DISABLED = prev;
  }
});

// ─── Metrics History (L1.5) ───

test('GET /api/telemetry/metrics/history returns 401 without session', async () => {
  const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 10 });
  const app = await buildApp({ metricsSnapshotStore: snapshotStore });
  const res = await app.inject({ method: 'GET', url: '/api/telemetry/metrics/history' });
  assert.equal(res.statusCode, 401);
  app.close();
});

test('GET /api/telemetry/metrics/history returns 503 when store is null', async () => {
  const app = await buildApp({ metricsSnapshotStore: null });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/metrics/history',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 503);
  app.close();
});

test('GET /api/telemetry/metrics/history returns snapshots', async () => {
  const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  snapshotStore.add({ timestamp: now - 2000, metrics: { a: 1 } });
  snapshotStore.add({ timestamp: now - 1000, metrics: { a: 2 } });
  snapshotStore.add({ timestamp: now, metrics: { a: 3 } });

  const app = await buildApp({ metricsSnapshotStore: snapshotStore });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/metrics/history',
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 3);
  assert.equal(body.snapshots.length, 3);
  app.close();
});

test('GET /api/telemetry/metrics/history filters by since', async () => {
  const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  snapshotStore.add({ timestamp: now - 5000, metrics: { old: 1 } });
  snapshotStore.add({ timestamp: now - 1000, metrics: { recent: 1 } });
  snapshotStore.add({ timestamp: now, metrics: { latest: 1 } });

  const app = await buildApp({ metricsSnapshotStore: snapshotStore });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: `/api/telemetry/metrics/history?since=${now - 2000}`,
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 2);
  app.close();
});

test('GET /api/telemetry/metrics/history respects limit', async () => {
  const snapshotStore = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    snapshotStore.add({ timestamp: now + i * 1000, metrics: { i } });
  }

  const app = await buildApp({ metricsSnapshotStore: snapshotStore });
  const cookie = await getSessionCookie(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/telemetry/metrics/history?limit=3',
    headers: { cookie },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.count, 3);
  app.close();
});
