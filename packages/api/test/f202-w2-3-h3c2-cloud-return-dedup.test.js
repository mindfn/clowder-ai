/**
 * F202 W2-3 h3c-2 — the polled reply ingest answers to the configured cloud cat too, and the two
 * return entries (Remote MCP callback, polled ingest) land one reply per source whichever arrives
 * first, and however they interleave (ledger「h3c 实现设计」h3c-2; astra `…000188`, negative case 2:
 * both arrival orders and a concurrent race — not just "they share a key builder").
 *
 * The races are driven, not hoped for: the harness pauses one entry right after it claimed the grant
 * (before its append) or right after its append (before the grant commit), then lets the other in.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  MemoryCloudReturnGrantStore,
  RedisCloudReturnGrantStore,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { buildCloudReturnMessageIdempotencyKey } from '../dist/domains/cats/services/cloud-bridge/cloud-return-message.js';
import { cloudReturnHarness, configureCats } from './helpers/cloud-return-harness.js';

beforeEach(() => configureCats(['cloud-alt']));

async function withCloudKey() {
  const h = await cloudReturnHarness();
  const { secret } = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  const mcp = (content, sourceMessageId = h.source.id) => h.post(secret, { content, replyTo: sourceMessageId });
  return { ...h, mcp };
}

async function onlyReply(h, sourceMessageId = h.source.id) {
  const replies = await h.repliesTo(sourceMessageId);
  assert.equal(replies.length, 1, `exactly one reply to ${sourceMessageId}`);
  return replies[0];
}

// ── The ingest follows the configuration ──

test('the ingest persists the reply as the configured cloud cat, under the shared exact-source key', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  const outcome = await h.ingest(h.source.id, 'polled answer');

  assert.equal(outcome.status, 'persisted');
  const reply = await onlyReply(h);
  assert.equal(reply.catId, 'cloud-alt');
  assert.equal(reply.id, outcome.messageId);
  const key = buildCloudReturnMessageIdempotencyKey(h.scope('cloud-alt'));
  assert.equal((await h.messageStore.getByIdempotencyKey('alice', h.thread.id, key)).id, reply.id);
  assert.equal(h.broadcasts.at(-1).message.catId, 'cloud-alt');
  assert.deepEqual(await h.grantStore.claim(h.scope('cloud-alt')), { ok: false, reason: 'consumed' });
});

test('the ingest refuses the wrong cat, the wrong thread, an unknown source, and no grant', async () => {
  const h = await cloudReturnHarness();
  await h.grant('gpt-pro');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });

  await h.grant('cloud-alt', h.source.id, h.otherThread.id);
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });

  assert.deepEqual(await h.ingest('no-such-message', 'x'), { status: 'rejected', reason: 'source_not_found' });
  assert.deepEqual(await h.ingest(h.unGranted.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('x')).length, 0);
});

test('with no cloud cat the provider is unavailable; with several it is refused, naming them', async () => {
  configureCats([]);
  let h = await cloudReturnHarness();
  await h.grant('cloud-alt');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'cloud_cat_unavailable' });

  configureCats(['cloud-alt', 'cloud-beta']);
  h = await cloudReturnHarness();
  await h.grant('cloud-alt');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'cloud_cat_ambiguous' });
  assert.deepEqual(h.warnings.at(-1).context.catIds, ['cloud-alt', 'cloud-beta']);
  assert.equal((await h.posted('x')).length, 0);
  assert.equal(
    (await h.grantStore.claim(h.scope('cloud-alt'))).ok,
    true,
    'the grant is left for a fixed configuration',
  );
});

test('a reply in flight while the cloud cat is renamed is refused, not re-attributed to the new cat', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  configureCats(['cloud-beta']);
  assert.deepEqual(await h.ingest(h.source.id, 'late answer'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('late answer')).length, 0);
  assert.equal((await h.grantStore.claim(h.scope('cloud-alt'))).ok, true);
});

// ── Negative case 2: one reply per source, in either order and under a race ──

test('Remote MCP first, then the poll: the poll is a duplicate of the MCP reply', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');

  assert.equal((await h.mcp('via MCP')).statusCode, 200);
  const polled = await h.ingest(h.source.id, 'via the page');

  const reply = await onlyReply(h);
  assert.deepEqual(polled, { status: 'duplicate', messageId: reply.id });
  assert.equal(reply.content, 'via MCP');
});

test('the poll first, then Remote MCP: the callback is a duplicate of the polled reply', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');

  assert.equal((await h.ingest(h.source.id, 'via the page')).status, 'persisted');
  const response = await h.mcp('via MCP');

  const reply = await onlyReply(h);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'duplicate');
  assert.equal(response.json().messageId, reply.id);
  assert.equal(reply.content, 'via the page');
});

test('race: the poll arrives while Remote MCP holds the grant, and retries into the duplicate', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');
  const paused = h.pauseAppend();
  const mcp = h.mcp('via MCP');
  await paused.reached;

  assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'retry', reason: 'grant_in_flight' });
  paused.release();
  assert.equal((await mcp).statusCode, 200);

  const reply = await onlyReply(h);
  assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'duplicate', messageId: reply.id });
  assert.equal(reply.content, 'via MCP');
});

test('race: Remote MCP arrives while the poll holds the grant, and retries into the duplicate', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');
  const paused = h.pauseAppend();
  const polled = h.ingest(h.source.id, 'via the page');
  await paused.reached;

  const early = await h.mcp('via MCP');
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().kind, 'cloud_return_grant_in_flight');
  paused.release();
  assert.equal((await polled).status, 'persisted');

  const reply = await onlyReply(h);
  const retried = await h.mcp('via MCP');
  assert.equal(retried.json().status, 'duplicate');
  assert.equal(retried.json().messageId, reply.id);
  assert.equal(reply.content, 'via the page');
});

test('race: whichever entry appended first wins even before its grant commit lands', async () => {
  for (const first of ['mcp', 'poll']) {
    const h = await withCloudKey();
    await h.grant('cloud-alt');
    const paused = h.pauseCommit();
    const winner = first === 'mcp' ? h.mcp('via MCP') : h.ingest(h.source.id, 'via the page');
    await paused.reached;

    const [reply] = await h.repliesTo(h.source.id);
    if (first === 'mcp') {
      assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'duplicate', messageId: reply.id });
    } else {
      const late = await h.mcp('via MCP');
      assert.equal(late.json().status, 'duplicate', late.body);
      assert.equal(late.json().messageId, reply.id);
    }
    paused.release();
    await winner;
    assert.equal((await onlyReply(h)).id, reply.id, `${first} first`);
    assert.deepEqual(await h.grantStore.claim(h.scope('cloud-alt')), { ok: false, reason: 'consumed' });
  }
});

test('race: both entries released together, in both start orders, still land one reply per source', async () => {
  const h = await withCloudKey();
  const sources = [];
  for (let index = 0; index < 20; index += 1) {
    const source = h.append(`source ${index}`);
    await h.grant('cloud-alt', source.id);
    sources.push(source);
  }

  await Promise.all(
    sources.map(async (source, index) => {
      const entries = [() => h.mcp(`via MCP ${index}`, source.id), () => h.ingest(source.id, `via the page ${index}`)];
      if (index % 2 === 1) entries.reverse();
      await Promise.all(entries.map((start) => start()));
      // A loser that met the grant in flight settles on its next attempt.
      await h.mcp(`via MCP ${index}`, source.id);
      await h.ingest(source.id, `via the page ${index}`);
    }),
  );

  for (const source of sources) {
    const reply = await onlyReply(h, source.id);
    assert.equal(reply.catId, 'cloud-alt');
    assert.deepEqual(await h.ingest(source.id, 'again'), { status: 'duplicate', messageId: reply.id });
  }
});

// ── P1-3 (astra, h3c-2 review): one source, one cloud cat ──
// A polled return carries no dispatch identity of its own, so a source that was ever granted to one
// cloud cat is never granted to another: a late answer from before a rename can then only miss.

function stringRedis() {
  const values = new Map();
  return {
    async set(key, value, ...options) {
      const exists = values.has(key);
      if ((options.includes('NX') && exists) || (options.includes('XX') && !exists)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    // Only the grant store's refresh of an existing grant runs a script here: same scope → refreshed.
    async eval(_script, _keyCount, key, threadId, userId, sourceMessageId, targetCatId) {
      const stored = JSON.parse(values.get(key) ?? 'null');
      if (!stored) return 0;
      const same =
        stored.threadId === threadId &&
        stored.userId === userId &&
        stored.sourceMessageId === sourceMessageId &&
        stored.targetCatId === targetCatId;
      return same ? 1 : -1;
    },
  };
}

for (const [name, store] of [
  ['memory', () => new MemoryCloudReturnGrantStore()],
  ['redis', () => new RedisCloudReturnGrantStore(stringRedis())],
]) {
  test(`${name}: a source granted to one cloud cat is never granted to another`, async () => {
    const grants = store();
    const source = { threadId: 't', userId: 'alice', sourceMessageId: 'S', dispatchInvocationId: 'inv-1' };
    assert.deepEqual(await grants.issue({ ...source, targetCatId: 'cloud-alt' }), { ok: true, status: 'issued' });
    assert.deepEqual(await grants.issue({ ...source, dispatchInvocationId: 'inv-2', targetCatId: 'cloud-beta' }), {
      ok: false,
      reason: 'source_retargeted',
      boundTargetCatId: 'cloud-alt',
    });
    assert.equal((await grants.claim({ ...source, targetCatId: 'cloud-beta' })).ok, false);
    assert.deepEqual(
      await grants.issue({ ...source, dispatchInvocationId: 'inv-3', targetCatId: 'cloud-alt' }),
      { ok: true, status: 'existing' },
      'the same cat again is a retry',
    );
    assert.deepEqual(
      await grants.issue({ ...source, sourceMessageId: 'S2', targetCatId: 'cloud-beta' }),
      { ok: true, status: 'issued' },
      'another source is free',
    );
  });
}

test('P1-3: after a rename the source cannot move to the new cat, and the old answer is refused', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  configureCats(['cloud-beta']);
  assert.deepEqual(await h.grant('cloud-beta'), {
    ok: false,
    reason: 'source_retargeted',
    boundTargetCatId: 'cloud-alt',
  });
  assert.deepEqual(await h.ingest(h.source.id, 'the old answer'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('the old answer')).length, 0);
  assert.equal((await h.grantStore.claim(h.scope('cloud-alt'))).ok, true, 'the old grant is not consumed either');
});

test('P1-3: a consumed grant keeps its source bound for as long as the consumed grant is kept', async () => {
  let now = 0;
  const hour = 3_600_000;
  const grants = new MemoryCloudReturnGrantStore(() => now);
  const source = { threadId: 't', userId: 'alice', sourceMessageId: 'S' };
  await grants.issue({ ...source, dispatchInvocationId: 'inv-1', targetCatId: 'cloud-alt' });
  now = 20 * hour;
  const claim = await grants.claim({ ...source, targetCatId: 'cloud-alt' });
  assert.equal(await grants.commit(claim), true);

  now = 30 * hour;
  assert.deepEqual(await grants.issue({ ...source, dispatchInvocationId: 'inv-2', targetCatId: 'cloud-beta' }), {
    ok: false,
    reason: 'source_retargeted',
    boundTargetCatId: 'cloud-alt',
  });
});
