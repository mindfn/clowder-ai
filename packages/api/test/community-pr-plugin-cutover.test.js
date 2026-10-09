import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { InMemoryCommunityIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryCommunityIssueStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { communityIssueRoutes } from '../dist/routes/community-issues.js';

test('PR sync and three read surfaces consume published plugin observations without the legacy producer/store', async (t) => {
  const repo = 'owner/repo';
  const taskStore = new TaskStore();
  const tracked = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: `pr:${repo}#7`,
    title: 'Host-owned title',
    ownerCatId: 'codex',
    threadId: 'host-thread',
    createdBy: 'codex',
  });
  let refreshes = 0;
  const status = {
    publishedGeneration: 'generation-a',
    observedAt: 9000,
    refreshStatus: 'incomplete',
    failedSubjects: [],
  };
  const row = (number) => ({
    id: `pr:${repo}#${number}`,
    repo,
    prNumber: number,
    title: 'Provider title',
    author: 'external',
    state: 'open',
    replyState: 'unreplied',
    headSha: 'a'.repeat(40),
    lastReviewedSha: null,
    draft: true,
    updatedAt: 1234,
    createdAt: 1234,
  });
  const source = {
    async repositories() {
      return [repo];
    },
    async read(value) {
      assert.equal(value, repo);
      return { items: [row(7), row(8)], status: { ...status } };
    },
    async refresh(value) {
      assert.equal(value, repo);
      refreshes++;
      return { status: 'incomplete', complete: false, hasMore: true };
    },
  };
  const forbidden = () => {
    throw Error('legacy PR producer/store must not run');
  };
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', 'owner');
  await app.register(communityIssueRoutes, {
    communityIssueStore: {
      async listAll() {
        return [];
      },
      async listByRepo() {
        return [];
      },
    },
    taskStore,
    socketManager: { broadcastToRoom() {} },
    pullRequests: source,
    communityPrStore: { listByRepo: forbidden, listAll: forbidden, create: forbidden, update: forbidden },
    fetchPrs: forbidden,
    fetchPrReviews: forbidden,
  });
  const sync = await app.inject({
    method: 'POST',
    url: `/api/community-issues/sync-prs?repo=${repo}`,
    headers: { host: 'localhost', origin: 'http://localhost' },
  });
  assert.equal(sync.statusCode, 202, sync.body);
  assert.equal(refreshes, 1, 'one HTTP request advances one bounded package step');
  const repos = await app.inject(`/api/community-repos`);
  assert.equal(repos.statusCode, 200, repos.body);
  assert.deepEqual(repos.json().repos, [repo]);
  const board = await app.inject(`/api/community-board?repo=${repo}`);
  assert.equal(board.statusCode, 200, board.body);
  const body = board.json();
  assert.deepEqual(body.prIndex, status);
  const own = body.prItems.find((item) => item.prNumber === 7);
  assert.equal(own.taskId, tracked.id);
  assert.equal(own.threadId, 'host-thread');
  assert.equal(own.title, 'Host-owned title');
  const provider = body.prItems.find((item) => item.prNumber === 8);
  assert.equal(provider.taskId, `pr:${repo}#8`);
  assert.equal(provider.updatedAt, 1234);
  assert.equal(provider.draft, true);
  status.refreshStatus = 'failed';
  status.failedSubjects = [8];
  const queue = await app.inject(`/api/community-decision-queue?repo=${repo}`);
  assert.equal(queue.statusCode, 200, queue.body);
  assert.deepEqual(queue.json().prIndex, status);
  const stale = await app.inject(`/api/community-board?repo=${repo}`);
  assert.equal(stale.json().prItems.find((item) => item.prNumber === 8).updatedAt, 1234);
  assert.deepEqual(stale.json().prIndex, status);
});

for (const path of ['community-board', 'community-decision-queue']) {
  test(`${path} canonicalizes mixed-case repo before joining Host tasks`, async (t) => {
    const tasks = new TaskStore();
    const task = tasks.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      title: 'Host title',
      threadId: 'host-thread',
      ownerCatId: 'codex',
    });
    const app = Fastify();
    t.after(() => app.close());
    const seen = [];
    await app.register(communityIssueRoutes, {
      communityIssueStore: {
        async listAll() {
          return [];
        },
        async listByRepo() {
          return [];
        },
      },
      taskStore: tasks,
      socketManager: { broadcastToRoom() {} },
      pullRequests: {
        async read(repo) {
          seen.push(repo);
          return {
            items: [
              {
                id: 'pr:owner/repo#7',
                repo: 'owner/repo',
                prNumber: 7,
                title: 'Provider title',
                state: 'open',
                replyState: 'unreplied',
                updatedAt: 1,
              },
            ],
            status: { publishedGeneration: 'g', observedAt: 1, refreshStatus: 'complete', failedSubjects: [] },
          };
        },
      },
    });
    const lower = await app.inject(`/api/${path}?repo=owner/repo`);
    const mixed = await app.inject(`/api/${path}?repo=Owner/Repo`);
    assert.equal(mixed.statusCode, 200, mixed.body);
    assert.deepEqual(seen, ['owner/repo', 'owner/repo']);
    assert.deepEqual(mixed.json(), lower.json());
    if (path === 'community-board') {
      const item = mixed.json().prItems[0];
      assert.equal(item.taskId, task.id);
      assert.equal(item.threadId, 'host-thread');
      assert.equal(item.ownerCatId, 'codex');
    }
  });
}

test('repository discovery keeps canonical Host sources and marks unavailable PR source', async (t) => {
  const tasks = new TaskStore();
  tasks.create({ kind: 'pr_tracking', subjectKey: 'pr:OWNER/REPO#7', title: 'Host task', threadId: 'host-thread' });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(communityIssueRoutes, {
    communityIssueStore: {
      async listAll() {
        return [{ repo: 'Owner/Repo' }, { repo: 'issue/only' }];
      },
    },
    taskStore: tasks,
    socketManager: { broadcastToRoom() {} },
    objectStore: {
      async listSubjectKeys() {
        return ['pr:owner/repo#8', 'pr:projection/only#2'];
      },
    },
    pullRequests: {
      async repositories() {
        throw Error('disabled');
      },
    },
  });
  const res = await app.inject('/api/community-repos');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().repos, ['issue/only', 'owner/repo', 'projection/only']);
  assert.equal(res.json().prSourceStatus, 'unavailable');
});

test('discovered canonical repo retains mixed-case stored issues, tasks and projection identities', async (t) => {
  const issues = new InMemoryCommunityIssueStore();
  const issue = await issues.create({
    repo: 'Owner/Repo',
    issueNumber: 3,
    issueType: 'feature',
    title: 'Stored issue',
  });
  await issues.update(issue.id, {
    state: 'pending-decision',
    assignedThreadId: 'issue-thread',
    directionCard: {
      entries: [
        { authoredByRole: 'narrator', routeRecommendation: { kind: 'new-thread' }, narrative: 'Decide', timestamp: 1 },
      ],
    },
  });
  const tasks = new TaskStore();
  const task = tasks.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:Owner/Repo#7',
    title: 'Stored PR',
    threadId: 'host-thread',
    ownerCatId: 'codex',
  });
  const projection = (subjectKey, number, state = 'fixed') => ({
    subjectKey,
    number,
    state,
    ownerThreadId: 'projection-thread',
    ownerRole: 'codex',
    nextOwner: 'case-owner',
    createdAt: 1,
    updatedAt: 2,
    linkedPrs: [],
    closureWaiver: null,
    lastPublicCommentAt: 1,
  });
  const projections = {
    'issue:OWNER/REPO#3': projection('issue:OWNER/REPO#3', 3, 'open'),
    'issue:Owner/Repo#4': projection('issue:Owner/Repo#4', 4),
    'pr:OWNER/REPO#7': projection('pr:OWNER/REPO#7', 7),
    'pr:Owner/Repo#9': projection('pr:Owner/Repo#9', 9),
  };
  const original = JSON.stringify(projections);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(communityIssueRoutes, {
    communityIssueStore: issues,
    taskStore: tasks,
    socketManager: { broadcastToRoom() {} },
    objectStore: {
      async listSubjectKeys() {
        return Object.keys(projections);
      },
      async get(key) {
        return projections[key] ?? null;
      },
    },
    pullRequests: {
      async repositories() {
        return ['owner/repo'];
      },
      async read() {
        return {
          items: [
            {
              id: 'pr:owner/repo#7',
              repo: 'owner/repo',
              prNumber: 7,
              title: 'Provider title',
              state: 'open',
              replyState: 'unreplied',
              updatedAt: 1,
            },
          ],
          status: { publishedGeneration: 'g', refreshStatus: 'complete', observedAt: 1, failedSubjects: [] },
        };
      },
    },
  });
  const repos = (await app.inject('/api/community-repos')).json().repos;
  assert.deepEqual(repos, ['owner/repo']);
  const board = (await app.inject('/api/community-board?repo=' + repos[0])).json();
  assert.equal(board.issues.find((i) => i.id === issue.id)?.title, 'Stored issue');
  assert.equal(board.issues.find((i) => i.id === issue.id)?.projectionState, 'open');
  assert.equal(board.issues.find((i) => i.issueNumber === 4)?.projectionState, 'fixed');
  const pr = board.prItems.find((i) => i.prNumber === 7);
  assert.equal(pr.taskId, task.id);
  assert.equal(pr.threadId, 'host-thread');
  assert.equal(pr.ownerCatId, 'codex');
  assert.equal(pr.title, 'Stored PR');
  assert.equal(pr.projectionState, 'fixed');
  assert.equal(board.prItems.find((i) => i.prNumber === 9)?.projectionState, 'fixed');
  const queue = (await app.inject('/api/community-decision-queue?repo=' + repos[0])).json();
  assert.ok(queue.items.some((i) => i.number === 3 && i.kind === 'direction-decision'));
  const queuedPr = queue.items.find((i) => i.number === 7 && i.subjectType === 'pr');
  assert.ok(queuedPr);
  assert.ok(queuedPr.recommendedActions.some((a) => a.kind === 'open-thread' && a.threadId === 'host-thread'));
  assert.ok(queue.items.some((i) => i.number === 9 && i.subjectType === 'pr'));
  assert.equal((await issues.get(issue.id)).repo, 'Owner/Repo');
  assert.equal((await tasks.get(task.id)).subjectKey, 'pr:Owner/Repo#7');
  assert.equal(JSON.stringify(projections), original);
});

for (const canonicalPresent of [true, false]) {
  for (const reversed of [true, false]) {
    test(`case collisions select one unchanged Host record across board/queue: canonical=${canonicalPresent} reversed=${reversed}`, async (t) => {
      const spellings = canonicalPresent ? ['Owner/Repo', 'owner/repo'] : ['Owner/Repo', 'OWNER/Repo'];
      if (reversed) spellings.reverse();
      const selectedRepo = canonicalPresent ? 'owner/repo' : 'OWNER/Repo';
      const issues = new InMemoryCommunityIssueStore(),
        tasks = new TaskStore();
      let selectedIssue, selectedTask;
      for (const repo of spellings) {
        const issue = await issues.create({ repo, issueNumber: 1, issueType: 'feature', title: `Issue ${repo}` });
        await issues.update(issue.id, {
          state: 'pending-decision',
          assignedThreadId: `issue-${repo}`,
          directionCard: {
            entries: [
              {
                authoredByRole: 'narrator',
                routeRecommendation: { kind: 'new-thread' },
                narrative: 'Decide',
                timestamp: 1,
              },
            ],
          },
        });
        const task = tasks.create({
          kind: 'pr_tracking',
          subjectKey: `pr:${repo}#7`,
          title: `PR ${repo}`,
          threadId: `thread-${repo}`,
          ownerCatId: repo === selectedRepo ? 'codex' : 'opus',
        });
        if (repo === selectedRepo) {
          selectedIssue = await issues.get(issue.id);
          selectedTask = task;
        }
      }
      const beforeIssues = JSON.stringify(await issues.listAll()),
        beforeTasks = JSON.stringify(await tasks.listByKind('pr_tracking'));
      const projection = {
        subjectKey: 'pr:owner/repo#7',
        number: 7,
        state: 'fixed',
        lastPublicCommentAt: 1,
        closureWaiver: null,
        updatedAt: 2,
        ownerThreadId: 'projection-thread',
      };
      const app = Fastify();
      t.after(() => app.close());
      await app.register(communityIssueRoutes, {
        communityIssueStore: issues,
        taskStore: tasks,
        socketManager: { broadcastToRoom() {} },
        objectStore: {
          async listSubjectKeys() {
            return [projection.subjectKey];
          },
          async get(key) {
            return key === projection.subjectKey ? projection : null;
          },
        },
        pullRequests: {
          async read() {
            return {
              items: [],
              status: { publishedGeneration: 'g', refreshStatus: 'complete', observedAt: 1, failedSubjects: [] },
            };
          },
        },
      });
      const board = (await app.inject('/api/community-board?repo=owner/repo')).json();
      assert.equal(board.issues.length, 1);
      assert.equal(board.issues[0].id, selectedIssue.id);
      assert.equal(board.issues[0].repo, selectedRepo);
      assert.equal(board.prItems.length, 1);
      assert.equal(board.prItems[0].taskId, selectedTask.id);
      assert.equal(board.prItems[0].threadId, selectedTask.threadId);
      assert.equal(board.prItems[0].ownerCatId, 'codex');
      const queue = (await app.inject('/api/community-decision-queue?repo=Owner/Repo')).json();
      const issueItems = queue.items.filter((i) => i.subjectType === 'issue'),
        prItems = queue.items.filter((i) => i.subjectType === 'pr');
      assert.equal(issueItems.length, 1);
      assert.equal(issueItems[0].title, selectedIssue.title);
      assert.ok(
        issueItems[0].recommendedActions.some(
          (a) => a.kind === 'open-thread' && a.threadId === selectedIssue.assignedThreadId,
        ),
      );
      assert.equal(prItems.length, 1);
      assert.equal(prItems[0].title, selectedTask.title);
      assert.ok(
        prItems[0].recommendedActions.some((a) => a.kind === 'open-thread' && a.threadId === selectedTask.threadId),
      );
      assert.equal(JSON.stringify(await issues.listAll()), beforeIssues);
      assert.equal(JSON.stringify(await tasks.listByKind('pr_tracking')), beforeTasks);
    });
  }
}
