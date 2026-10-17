import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** In-memory Redis mock with GET/SET/DEL */
function createMockRedis() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, exToken, ttl) {
      store.set(key, { value, exToken, ttl });
      return 'OK';
    },
    async del(...keys) {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
  };
}

describe('ReconciliationDedup', () => {
  let redis;
  let dedup;

  beforeEach(async () => {
    const { ReconciliationDedup } = await import(
      '../dist/infrastructure/connectors/github-repo-event/ReconciliationDedup.js'
    );
    redis = createMockRedis();
    dedup = new ReconciliationDedup(redis);
  });

  it('returns false for a new item', async () => {
    const result = await dedup.isNotified('fixture-owner/first-repo', 'pr', 42);
    assert.equal(result, false);
  });

  it('returns true after markNotified', async () => {
    await dedup.markNotified('fixture-owner/first-repo', 'pr', 42);
    const result = await dedup.isNotified('fixture-owner/first-repo', 'pr', 42);
    assert.equal(result, true);
  });

  it('tracks PRs and Issues independently', async () => {
    await dedup.markNotified('fixture-owner/first-repo', 'pr', 10);
    assert.equal(await dedup.isNotified('fixture-owner/first-repo', 'pr', 10), true);
    assert.equal(await dedup.isNotified('fixture-owner/first-repo', 'issue', 10), false);
  });

  it('tracks repos independently', async () => {
    await dedup.markNotified('fixture-owner/first-repo', 'pr', 5);
    assert.equal(await dedup.isNotified('fixture-owner/first-repo', 'pr', 5), true);
    assert.equal(await dedup.isNotified('fixture-owner/second-repo', 'pr', 5), false);
  });

  it('uses correct key prefix', async () => {
    await dedup.markNotified('fixture-owner/first-repo', 'pr', 99);
    assert.ok(redis.store.has('f141:notified:fixture-owner/first-repo#pr-99'));
  });

  it('tracks repo baseline independently from item notifications', async () => {
    assert.equal(await dedup.isBaselineEstablished('fixture-owner/first-repo'), false);

    await dedup.markBaselineEstablished('fixture-owner/first-repo');

    assert.equal(await dedup.isBaselineEstablished('fixture-owner/first-repo'), true);
    assert.equal(await dedup.isBaselineEstablished('fixture-owner/second-repo'), false);
    assert.equal(await dedup.isNotified('fixture-owner/first-repo', 'pr', 99), false);
  });

  it('stores notified markers without TTL', async () => {
    await dedup.markNotified('fixture-owner/first-repo', 'issue', 100);
    const entry = redis.store.get('f141:notified:fixture-owner/first-repo#issue-100');

    assert.equal(entry.value, '1');
    assert.equal(entry.exToken, undefined);
    assert.equal(entry.ttl, undefined);
  });

  it('stores baseline markers without TTL', async () => {
    await dedup.markBaselineEstablished('fixture-owner/first-repo');
    const entry = redis.store.get('f141:baseline:fixture-owner/first-repo');

    assert.equal(entry.value, '1');
    assert.equal(entry.exToken, undefined);
    assert.equal(entry.ttl, undefined);
  });

  it('migrates old TTL markers to persistent markers when observed', async () => {
    await redis.set('f141:notified:fixture-owner/first-repo#pr-101', '1', 'EX', 604800);

    assert.equal(await dedup.isNotified('fixture-owner/first-repo', 'pr', 101), true);
    const entry = redis.store.get('f141:notified:fixture-owner/first-repo#pr-101');
    assert.equal(entry.value, '1');
    assert.equal(entry.exToken, undefined);
    assert.equal(entry.ttl, undefined);
  });
});
