/**
 * F257 fix (verdict PR #39): hold_ball must NOT auto-retry on 429.
 *
 * Root cause: callback-retry treats 429 as retryable (shouldRetryStatus).
 * hold_ball's 429 means "MAX_HOLDS_PER_WINDOW (3/h) reached" — the window
 * is 1 hour, so retrying in 1s/2s/4s will never succeed. The default retry
 * policy caused 3 identical POSTs, each emitting a GuardRejectionEvent,
 * hitting the threshold-escalation trigger on retry noise rather than
 * genuine independent violations.
 *
 * Fix: handleHoldBall passes { retryDelaysMs: [] } to callbackPost, making
 * it a single-attempt call. The 429 error is still surfaced to the cat.
 *
 * Evidence: 3 events in 3,032ms from thread_mrkn6povq4zzgh45/gpt52,
 * intervals ~1,016ms and ~2,016ms matching DEFAULT_RETRY_DELAYS_MS [1000, 2000, 4000].
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('hold_ball 429 — no auto-retry (F257 fix)', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    // Point callback at a fake server — we just need the config to exist
    process.env.CAT_CAFE_CALLBACK_API_URL = 'http://127.0.0.1:19999';
    process.env.CAT_CAFE_CALLBACK_AUTH_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test('429 response causes exactly 1 fetch (no retry)', async () => {
    let fetchCount = 0;
    const fetchUrls = [];

    globalThis.fetch = async (url, _opts) => {
      fetchCount++;
      fetchUrls.push(String(url));
      return {
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: 'maxHoldsPerWindow (3 per ~1h window) reached. You MUST pass the ball now.',
            holdsInWindow: 3,
            maxHoldsPerWindow: 3,
            windowMs: 3600000,
          }),
        json: async () => ({}),
      };
    };

    // Dynamic import to pick up env config
    const { handleHoldBall } = await import('../dist/tools/callback-tools.js');
    const result = await handleHoldBall({
      reason: 'test',
      nextStep: 'test',
      wakeAfterMs: 10000,
      waitSourceRef: {
        kind: 'github_issue',
        value: '#1',
        expectedSignal: 'close',
        slaUntilMs: Date.now() + 60000,
      },
    });

    assert.equal(fetchCount, 1, 'hold_ball 429 must NOT be retried — exactly 1 fetch');
    assert.ok(
      fetchUrls[0].includes('/api/callbacks/hold-ball'),
      'the single fetch should target /api/callbacks/hold-ball',
    );
    assert.equal(result.isError, true, '429 should surface as an error to the cat');
  });

  test('successful hold_ball still makes only 1 fetch (no regression)', async () => {
    let fetchCount = 0;

    globalThis.fetch = async (url) => {
      fetchCount++;
      // Only the hold-ball endpoint responds with success; others (like freshness) also get called
      if (String(url).includes('/api/callbacks/hold-ball')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'hold-ball-test-123', scheduled: true }),
        };
      }
      // Freshness reminder call (F254 B2) — return empty
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    };

    const { handleHoldBall } = await import('../dist/tools/callback-tools.js');
    const result = await handleHoldBall({
      reason: 'test',
      nextStep: 'test',
      wakeAfterMs: 10000,
      waitSourceRef: {
        kind: 'github_issue',
        value: '#1',
        expectedSignal: 'close',
        slaUntilMs: Date.now() + 60000,
      },
    });

    assert.ok(!result.isError, 'successful hold_ball should not be an error');
    // hold-ball + freshness-reminder = 2 fetches on success path
    assert.ok(fetchCount <= 2, `expected at most 2 fetches (hold + freshness), got ${fetchCount}`);
  });
});
