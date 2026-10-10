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
function fixture(invoke, now = () => 1000) {
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
    now,
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

const signalTask = (changes = {}) => ({
  id: 'task',
  kind: 'pr_tracking',
  subjectKey: `pr:${repo}#1`,
  status: 'doing',
  threadId: 'thread',
  ownerCatId: 'codex',
  userId: 'user',
  pluginWait: {
    pluginInstanceId: 'instance',
    generation: 2,
    threadId: 'thread',
    catId: 'codex',
    userId: 'user',
    await: { generation: 2, expiresAt: 2000 },
    registration: { invocationId: 'inv', source: { kind: 'primary', sourceMessageId: 'source' }, registeredAt: 100 },
  },
  ...changes,
});
const observedHead = () => ({
  currentHeadSha: 'a'.repeat(40),
  headGeneration: 2,
  currentHeadObservedAt: 110,
  ci: { headSha: 'a'.repeat(40), headGeneration: 2, status: 'pass', observedAt: 120 },
});
const subjectObservation = (head = observedHead()) => ({
  data: {
    subjectKey: `pr:${repo}#1`,
    projection: { subjectKey: `pr:${repo}#1`, externalReview: head },
    events: [],
    nextSequence: null,
  },
});

test('task CI uses installed exact-subject observations and ignores private governance fields', async () => {
  const head = {
    ...observedHead(),
    pendingVerdict: { verdict: 'approved' },
    ownerCatId: 'forged',
    lifecycle: 'terminal',
  };
  const f = fixture((method, params) => {
    assert.equal(method, 'github.subject.inspect');
    assert.deepEqual(params, { subjectKey: `pr:${repo}#1`, limit: 1 });
    return subjectObservation(head);
  });
  assert.deepEqual(await f.source.taskSignals(signalTask()), { ciPassed: true, merged: false });
});

for (const [name, change] of [
  [
    'pending',
    (h) => {
      h.ci.status = 'pending';
    },
  ],
  [
    'failed',
    (h) => {
      h.ci.status = 'fail';
    },
  ],
  [
    'different SHA',
    (h) => {
      h.ci.headSha = 'b'.repeat(40);
    },
  ],
  [
    'same SHA from old generation',
    (h) => {
      h.ci.headGeneration = 1;
    },
  ],
  [
    'observation before head',
    (h) => {
      h.ci.observedAt = 109;
    },
  ],
  [
    'observation before registration',
    (h) => {
      h.currentHeadObservedAt = 50;
      h.ci.observedAt = 90;
    },
  ],
  [
    'future observation',
    (h) => {
      h.ci.observedAt = 1001;
    },
  ],
  [
    'absent CI',
    (h) => {
      h.ci = null;
    },
  ],
]) {
  test(`task CI does not treat ${name} as current pass`, async () => {
    const head = observedHead();
    change(head);
    const f = fixture(() => subjectObservation(head));
    assert.deepEqual(await f.source.taskSignals(signalTask()), { ciPassed: false, merged: false });
  });
}

for (const [name, change] of [
  [
    'no wait',
    (t) => {
      delete t.pluginWait;
    },
  ],
  [
    'canceled wait',
    (t) => {
      t.pluginWait.invalidated = 'user_cancel';
    },
  ],
  [
    'expired wait',
    (t) => {
      t.pluginWait.await.expiresAt = 1000;
    },
  ],
  [
    'no active wait',
    (t) => {
      delete t.pluginWait.await;
    },
  ],
  [
    'wrong generation',
    (t) => {
      t.pluginWait.await.generation = 1;
    },
  ],
  [
    'different thread',
    (t) => {
      t.threadId = 'other';
    },
  ],
  [
    'different owner',
    (t) => {
      t.ownerCatId = 'opus';
    },
  ],
  [
    'different user',
    (t) => {
      t.userId = 'other';
    },
  ],
  [
    'no registration',
    (t) => {
      delete t.pluginWait.registration;
    },
  ],
]) {
  test(`task CI refuses ${name} without invoking plugin`, async () => {
    const t = signalTask();
    change(t);
    const f = fixture(() => subjectObservation());
    assert.equal(await f.source.taskSignals(t), null);
    assert.equal(f.calls(), 0);
  });
}

test('wait expiration during an action cannot produce a successful signal', async () => {
  let now = 1000;
  const f = fixture(
    () => {
      now = 2000;
      return subjectObservation();
    },
    () => now,
  );
  assert.equal(await f.source.taskSignals(signalTask()), null);
});

test('CI rejects mismatched response identity and malformed provider fields', async () => {
  for (const change of [
    (v) => {
      v.data.subjectKey = `pr:${repo}#2`;
    },
    (v) => {
      v.data.projection.subjectKey = `pr:${repo}#2`;
    },
    (v) => {
      v.data.projection.externalReview.ci.status = 'approved';
    },
    (v) => {
      v.data.projection.externalReview.currentHeadSha = 'bad';
    },
    (v) => {
      v.data.projection.externalReview.ci.headGeneration = 0;
    },
  ]) {
    const v = subjectObservation();
    change(v);
    await assert.rejects(fixture(() => v).source.taskSignals(signalTask()));
  }
});

test('task observations reject a changed installation or activation during reading', async () => {
  const f = fixture(() => {
    f.instance.lifecycleRevision++;
    return subjectObservation();
  });
  await assert.rejects(f.source.taskSignals(signalTask()), /changed/);
  const replaced = signalTask();
  replaced.pluginWait.pluginInstanceId = 'old-instance';
  const g = fixture(() => subjectObservation());
  await assert.rejects(g.source.taskSignals(replaced), /instance changed/);
  assert.equal(g.calls(), 0);
});

test('terminal task reads explicit merged state from a complete publication, not private verdict', async () => {
  const f = fixture((method) => {
    assert.equal(method, 'github.repository.observations');
    return page([row(1, { state: 'merged' })]);
  });
  assert.deepEqual(await f.source.taskSignals(signalTask({ status: 'done' })), { ciPassed: false, merged: true });
  const closed = fixture(() => page([row(1, { state: 'closed' })]));
  assert.deepEqual(await closed.source.taskSignals(signalTask({ status: 'done' })), { ciPassed: false, merged: false });
});

test('incomplete, failed, absent and unrelated snapshots cannot prove task merge', async () => {
  for (const status of ['never', 'incomplete', 'failed', 'limit_exceeded']) {
    const f = fixture(() => {
      const v = page([row(1, { state: 'merged' })]);
      v.data.pullRequests.refreshStatus = status;
      return v;
    });
    assert.equal(await f.source.taskSignals(signalTask({ status: 'done' })), null);
  }
  for (const field of ['publishedGeneration', 'observedAt']) {
    const f = fixture(() => {
      const v = page([row(1, { state: 'merged' })]);
      v.data.pullRequests[field] = null;
      return v;
    });
    assert.equal(await f.source.taskSignals(signalTask({ status: 'done' })), null);
  }
  const f = fixture(() => page([row(2, { state: 'merged' })]));
  assert.deepEqual(await f.source.taskSignals(signalTask({ status: 'done' })), { ciPassed: false, merged: false });
});

test('unavailable installed provider has no legacy task-state fallback', async () => {
  const f = fixture(() => {
    throw Error('provider unavailable');
  });
  const t = signalTask();
  t.automationState = { ci: { lastBucket: 'pass', prState: 'merged' } };
  await assert.rejects(f.source.taskSignals(t), /provider unavailable/);
  f.instance.activationState = 'disabled';
  await assert.rejects(f.source.taskSignals(t), /unavailable/);
});
