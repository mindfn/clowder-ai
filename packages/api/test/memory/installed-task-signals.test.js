import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadAwareSignalSources } from '../../dist/domains/memory/ThreadAwareSignalSources.js';

// Provider observations are supplied by the installed-plugin adapter. Thread/task
// selection and protection against reassignment remain Host responsibilities.
const threadId = 'signal-thread';
const task = (number = 1, overrides = {}) => ({
  id: `task-${number}`,
  kind: 'pr_tracking',
  subjectKey: `pr:owner/repo#${number}`,
  threadId,
  ownerCatId: 'codex',
  status: 'doing',
  ...overrides,
});
const noSignals = { ciPassed: false, merged: false };
function fixture(initial, observe = async () => noSignals) {
  const tasks = structuredClone(initial);
  const calls = [];
  const source = new ThreadAwareSignalSources(
    { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
    { getByThread: async () => [] },
    { listByThread: async () => tasks.filter((t) => t.threadId === threadId) },
    {
      async read(t) {
        calls.push(structuredClone(t));
        return observe(t, tasks);
      },
    },
  );
  return { source, tasks, calls };
}

test('installed CI observation works without legacy automationState.ci', async () => {
  const f = fixture([task()], async () => ({ ciPassed: true, merged: false }));
  assert.equal(await f.source.isCiPassedForThread(threadId), true);
  assert.equal(f.calls[0].subjectKey, 'pr:owner/repo#1');
});

test('a legacy CI pass cannot replace a missing installed observation', async () => {
  const f = fixture(
    [
      task(1, {
        automationState: {
          ci: {
            headSha: 'old',
            lastFingerprint: 'old:pass',
            lastBucket: 'pass',
          },
        },
      }),
    ],
    async () => null,
  );
  assert.equal(await f.source.isCiPassedForThread(threadId), false);
});

test('a legacy merge cannot replace a missing installed observation', async () => {
  const f = fixture([task(1, { status: 'done', automationState: { ci: { prState: 'merged' } } })], async () => null);
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
});

test('terminal task plus explicit installed merge observation is recognized', async () => {
  const f = fixture([task(1, { status: 'done' })], async () => ({ ciPassed: false, merged: true }));
  assert.equal(await f.source.isPrMergedForThread(threadId), true);
});

test('done alone or a provider closed observation never means merged', async () => {
  const f = fixture([task(1, { status: 'done' })]);
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
});

test('active PR work prevents an older merge from verifying the thread', async () => {
  const f = fixture([task(1, { status: 'done' }), task(2)], async () => ({ ciPassed: false, merged: true }));
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
  assert.equal(f.calls.length, 0);
});

test('only latest terminal task determines merge, with no scan back to old merged work', async () => {
  const f = fixture([task(1, { status: 'done' }), task(2, { status: 'done' })], async (t) => ({
    ciPassed: false,
    merged: t.id === 'task-1',
  }));
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
  assert.deepEqual(
    f.calls.map((t) => t.id),
    ['task-2'],
  );
});

test('latest merged observation survives an older closed task', async () => {
  const f = fixture([task(1, { status: 'done' }), task(2, { status: 'done' })], async (t) => ({
    ciPassed: false,
    merged: t.id === 'task-2',
  }));
  assert.equal(await f.source.isPrMergedForThread(threadId), true);
});

test('CI only reads active PR tasks, ignoring completed and unrelated tasks', async () => {
  const f = fixture([task(1, { status: 'done' }), task(2), task(3, { kind: 'work' })], async () => ({
    ciPassed: true,
    merged: false,
  }));
  assert.equal(await f.source.isCiPassedForThread(threadId), true);
  assert.deepEqual(
    f.calls.map((t) => t.id),
    ['task-2'],
  );
});

test('no matching task means no provider read or positive signal', async () => {
  const f = fixture([task(1, { kind: 'issue_tracking' }), task(2, { threadId: 'elsewhere' })], async () => ({
    ciPassed: true,
    merged: true,
  }));
  assert.equal(await f.source.isCiPassedForThread(threadId), false);
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
  [
    'owner',
    (tasks) => {
      tasks[0].ownerCatId = 'opus';
    },
  ],
  [
    'thread',
    (tasks) => {
      tasks[0].threadId = 'elsewhere';
    },
  ],
  [
    'status',
    (tasks) => {
      tasks[0].status = 'done';
    },
  ],
  [
    'wait generation',
    (tasks) => {
      tasks[0].pluginWait = { generation: 2 };
    },
  ],
]) {
  test(`CI response cannot verify a task whose ${name} changed during read`, async () => {
    const f = fixture([task()], async (_t, tasks) => {
      change(tasks);
      return { ciPassed: true, merged: false };
    });
    assert.equal(await f.source.isCiPassedForThread(threadId), false);
    assert.equal(f.calls.length, 1);
  });
}

test('new active work created during merge read prevents a stale thread signal', async () => {
  const f = fixture([task(1, { status: 'done' })], async (_t, tasks) => {
    tasks.push(task(2));
    return { ciPassed: false, merged: true };
  });
  assert.equal(await f.source.isPrMergedForThread(threadId), false);
  assert.equal(f.calls.length, 1);
});

test('provider receives an isolated task snapshot, not the mutable Host aggregate', async () => {
  const f = fixture([task()], async (t) => {
    t.ownerCatId = 'changed-by-reader';
    return noSignals;
  });
  assert.equal(await f.source.isCiPassedForThread(threadId), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.tasks[0].ownerCatId, 'codex');
});

test('missing provider source does not revive legacy task observations', async () => {
  const source = new ThreadAwareSignalSources(
    { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
    { getByThread: async () => [] },
    { listByThread: async () => [task(1, { status: 'done', automationState: { ci: { prState: 'merged' } } })] },
  );
  assert.equal(await source.isPrMergedForThread(threadId), false);
});
