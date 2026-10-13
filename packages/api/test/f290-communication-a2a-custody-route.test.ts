import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import { type DeferCase, routeCustodyFixture, type ScopeCase } from './f290-communication-a2a-custody-route.fixture.js';

for (const scope of ['private', 'public', 'delegated-private'] satisfies ScopeCase[]) {
  for (const defer of ['busy', 'pending', 'interrupted'] satisfies DeferCase[]) {
    test(`${scope} provider text @ stays display-only through actual ${defer} routeSerial branch`, async () => {
      const f = await routeCustodyFixture(scope, defer);
      try {
        await f.run();
        assert.equal(f.calls.length, 1, 'The test must reach the actual scoped provider exactly once');
        assert.equal(f.calls[0].policy, scope === 'public' ? 'collective_participation' : 'collective_work');
        assert.equal(
          f.calls.some((call) => call.catId === NEXT_CAT),
          false,
          'Text never starts a downstream Cat',
        );
        const escaped = f.queue.list(f.threadId, f.cafe.ownerUserId);
        assert.equal(
          escaped.length,
          0,
          `Collective text must not defer ordinary home custody: ${JSON.stringify(escaped.map((entry) => ({ source: entry.from, scope: entry.execution.executionScope ?? 'home', target: entry.targets })))}`,
        );
      } finally {
        await f.close();
      }
    });
  }
}

for (const defer of ['busy', 'pending', 'interrupted'] satisfies DeferCase[]) {
  test(`ordinary home text @ retains actual ${defer} deferred routing as a positive control`, async () => {
    const f = await routeCustodyFixture('home', defer);
    try {
      await f.run();
      assert.equal(f.calls[0]?.policy, undefined);
      const deferred = f.queue.list(f.threadId, f.cafe.ownerUserId);
      if (defer === 'interrupted') {
        assert.equal(deferred.length, 0, 'Interrupted output is not a completed A2A source');
        return;
      }
      assert.equal(deferred.length, 1, 'Completed output admits one independent Queue successor');
      assert.deepEqual(deferred[0].targets, [NEXT_CAT]);
      assert.equal(deferred[0].from.kind, 'agent');
      assert.equal(deferred[0].execution.executionScope, undefined);
      assert.ok(deferred[0].execution.a2aTriggerMessageId, 'Durable output supplies the actual deferred trigger');
    } finally {
      await f.close();
    }
  });
}
