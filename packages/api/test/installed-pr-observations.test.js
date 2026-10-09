import assert from 'node:assert/strict';
import test from 'node:test';
import { InstalledPrObservations } from '../dist/domains/community/installed-pr-observations.js';

const repo = 'owner/repo';
const row = (number, changes = {}) => ({
  repo,
  number,
  subjectKey: `pr:${repo}#${number}`,
  title: 'PR',
  author: 'human',
  state: 'open',
  replyState: 'unreplied',
  headSha: 'a'.repeat(40),
  lastReviewedSha: null,
  draft: true,
  updatedAt: 123,
  ...changes,
});
const page = (items, nextAfter = null, publishedGeneration = 'g1') => ({
  data: {
    pullRequests: {
      items,
      nextAfter,
      publishedGeneration,
      observedAt: 456,
      refreshStatus: 'complete',
      failedSubjects: [],
    },
  },
});
function fixture(invoke) {
  const instance = {
    pluginId: 'official.github-operations',
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
    lifecycleRevision: 1,
  };
  let calls = 0;
  const source = new InstalledPrObservations(
    {
      async snapshot() {
        return { instances: [instance], grants: [{ pluginInstanceId: 'instance', grantRevision: 1 }] };
      },
    },
    {
      async invoke(id, method, params) {
        assert.equal(id, 'instance');
        calls++;
        return invoke(method, params, calls);
      },
    },
  );
  return { source, instance, calls: () => calls };
}
test('published observations retain provider time, stable identity, draft and null review SHA across pages', async () => {
  const { source, calls } = fixture((method, params, count) => {
    assert.equal(method, 'github.repository.observations');
    assert.equal(params.repo, repo);
    assert.equal(params.limit, 100);
    if (count === 1) return page([row(1)], 'g1:1');
    assert.equal(params.prAfter, 'g1:1');
    return page([row(2, { draft: false, state: 'closed' })]);
  });
  const result = await source.read('Owner/Repo');
  assert.equal(calls(), 2);
  assert.equal(result.items[0].id, 'pr:owner/repo#1');
  assert.equal(result.items[0].updatedAt, 123);
  assert.equal(result.items[1].draft, false);
  assert.equal(result.items[1].lastReviewedSha, null);
});
test('stale publication cursor restarts once without mixing generations', async () => {
  const { source, calls } = fixture((_method, params, count) => {
    if (count === 1) return page([row(1)], 'g1:1');
    if (count === 2) throw Error('stale or invalid PR cursor');
    assert.equal(params.prAfter, undefined);
    return page([row(2)], null, 'g2');
  });
  const result = await source.read(repo);
  assert.equal(calls(), 3);
  assert.deepEqual(
    result.items.map((item) => item.prNumber),
    [2],
  );
  assert.equal(result.status.publishedGeneration, 'g2');
});
test('cursor races, repetition, malformed identity and overlong traversals fail boundedly', async () => {
  const racing = fixture((_m, _p, n) =>
    n % 2 ? page([row(n)], 'g1:1') : Promise.reject(Error('stale or invalid PR cursor')),
  );
  await assert.rejects(racing.source.read(repo), /stale/);
  assert.equal(racing.calls(), 4);
  const repeated = fixture((_m, _p, n) => page([row(n)], 'same'));
  await assert.rejects(repeated.source.read(repo), /cursor/);
  assert.equal(repeated.calls(), 2);
  const wrong = fixture(() => page([row(1, { subjectKey: 'pr:other/repo#1' })]));
  await assert.rejects(wrong.source.read(repo), /identity/);
  const unbounded = fixture((_m, _p, n) => page([row(n)], `g1:${n}`));
  await assert.rejects(unbounded.source.read(repo), /bound/);
  assert.equal(unbounded.calls(), 50);
});
test('failed refresh keeps old published rows and reports provider failure', async () => {
  const { source } = fixture(() => {
    const result = page([row(1)]);
    result.data.pullRequests.refreshStatus = 'failed';
    result.data.pullRequests.failedSubjects = [2];
    return result;
  });
  const result = await source.read(repo);
  assert.equal(result.items.length, 1);
  assert.equal(result.status.refreshStatus, 'failed');
  assert.deepEqual(result.status.failedSubjects, [2]);
});
test('disabled or changed instance cannot return a successful observation', async () => {
  const f = fixture(() => {
    f.instance.lifecycleRevision++;
    return page([row(1)]);
  });
  await assert.rejects(f.source.read(repo), /changed/);
  f.instance.activationState = 'disabled';
  await assert.rejects(f.source.read(repo), /unavailable/);
  assert.equal(f.calls(), 1);
});
test('refresh performs exactly one bounded step and repository discovery is read only', async () => {
  const f = fixture((method, params) => {
    if (method === 'github.repository.list')
      return { data: { pullRequestRepositories: [{ repo: 'Owner/Repo' }, { repo }] } };
    assert.equal(method, 'github.pull-requests.refresh');
    assert.deepEqual(params, { repo, restart: true });
    return {
      data: { status: 'incomplete', complete: false, hasMore: true, publishedGeneration: null, failedSubjects: [] },
    };
  });
  assert.deepEqual(await f.source.repositories(), [repo]);
  assert.equal((await f.source.refresh(repo, true)).status, 'incomplete');
  assert.equal(f.calls(), 2);
});
