/**
 * F220 Phase D: Issue Tracking — TDD tests
 *
 * AC-D1: issue_tracking TaskKind + eviction protection
 * AC-D2: IssueCommentRouter builds correct notification content
 * AC-D3: register_issue_tracking endpoint creates issue_tracking task
 * AC-D4: Auto-close when issue is closed
 * AC-D-security: untrusted external content boundary on issue comments
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

// D1: subject key helpers (must exist in shared)
const { issueSubjectKey, parseIssueSubjectKey } = await import('@cat-cafe/shared');

// D2/D3: IssueCommentRouter + TaskSpec (may not exist yet → catch)
let buildIssueCommentContent;
try {
  const mod = await import('../dist/infrastructure/email/IssueCommentRouter.js');
  buildIssueCommentContent = mod.buildIssueCommentContent;
} catch {
  // Will be created during GREEN phase
}

let createIssueCommentTaskSpec;
try {
  const mod = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
  createIssueCommentTaskSpec = mod.createIssueCommentTaskSpec;
} catch {
  // Will be created during GREEN phase
}

// Schedule factory registration (file exists, just checking new factory)
let registerGitHubScheduleFactories;
try {
  const mod = await import('../dist/domains/plugin/github-schedule-factories.js');
  registerGitHubScheduleFactories = mod.registerGitHubScheduleFactories;
} catch {
  // Unexpected — file already exists
}

// ── AC-D1: issue_tracking TaskKind + eviction protection ──────────

describe('AC-D1: issue_tracking TaskKind', () => {
  test('TaskStore accepts kind=issue_tracking', () => {
    const store = new TaskStore();
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:owner/repo#42',
      title: 'Issue tracking: owner/repo#42',
      why: 'Tracking issue',
      createdBy: 'cat1',
    });
    assert.strictEqual(task.kind, 'issue_tracking');
    assert.strictEqual(task.subjectKey, 'issue:owner/repo#42');
  });

  test('issue_tracking tasks are protected from eviction', () => {
    const store = new TaskStore({ maxTasks: 3 });

    // Create issue_tracking task (protected)
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#1',
      title: 'Issue #1',
      why: 'track',
      createdBy: 'cat1',
    });

    // Create 2 work tasks (not protected)
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });
    store.create({ kind: 'work', threadId: 't1', title: 'w2', why: 'w', createdBy: 'cat1' });

    // Trigger eviction — issue_tracking should survive
    store.create({ kind: 'work', threadId: 't1', title: 'w3', why: 'w', createdBy: 'cat1' });

    const issueTask = store.getBySubject('issue:o/r#1');
    assert.ok(issueTask, 'issue_tracking task should survive eviction');
    assert.strictEqual(issueTask.kind, 'issue_tracking');
  });

  test('done issue_tracking tasks are NOT protected from eviction', () => {
    const store = new TaskStore({ maxTasks: 2 });

    // Create issue_tracking task and mark done
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#2',
      title: 'Issue #2',
      why: 'track',
      createdBy: 'cat1',
    });
    store.update(task.id, { status: 'done' });

    // Fill to capacity
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });
    store.create({ kind: 'work', threadId: 't1', title: 'w2', why: 'w', createdBy: 'cat1' });

    const evicted = store.getBySubject('issue:o/r#2');
    assert.strictEqual(evicted, null, 'done issue_tracking task should be evicted');
  });

  test('listByKind returns issue_tracking tasks', () => {
    const store = new TaskStore();
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#10',
      title: 'Issue #10',
      why: 'track',
      createdBy: 'cat1',
    });
    store.create({ kind: 'work', threadId: 't1', title: 'w1', why: 'w', createdBy: 'cat1' });

    const issues = store.listByKind('issue_tracking');
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].kind, 'issue_tracking');
  });
});

// ── Subject key helpers ───────────────────────────────────────────

describe('Issue subject key helpers', () => {
  test('issueSubjectKey generates correct format', () => {
    assert.strictEqual(issueSubjectKey('owner/repo', 42), 'issue:owner/repo#42');
  });

  test('parseIssueSubjectKey parses valid key', () => {
    const parsed = parseIssueSubjectKey('issue:owner/repo#42');
    assert.deepStrictEqual(parsed, { repoFullName: 'owner/repo', issueNumber: 42 });
  });

  test('parseIssueSubjectKey returns null for non-issue key', () => {
    assert.strictEqual(parseIssueSubjectKey('pr:owner/repo#42'), null);
  });

  test('parseIssueSubjectKey returns null for malformed key', () => {
    assert.strictEqual(parseIssueSubjectKey('issue:nohash'), null);
  });
});

// ── AC-D2: IssueCommentRouter content building ────────────────────

describe('AC-D2: IssueCommentRouter', () => {
  test('buildIssueCommentContent produces issue notification with correct header', () => {
    assert.ok(buildIssueCommentContent, 'buildIssueCommentContent should be importable');
    const content = buildIssueCommentContent({
      repoFullName: 'owner/repo',
      issueNumber: 42,
      newComments: [{ id: 1, author: 'alice', body: 'Fix this bug', createdAt: '2026-01-01T00:00:00Z' }],
    });
    assert.ok(content.includes('Issue #42'), 'should include issue number');
    assert.ok(content.includes('owner/repo'), 'should include repo name');
    assert.ok(content.includes('alice'), 'should include author');
  });

  test('buildIssueCommentContent wraps bodies in [UNTRUSTED EXTERNAL CONTENT]', () => {
    assert.ok(buildIssueCommentContent, 'buildIssueCommentContent should be importable');
    const content = buildIssueCommentContent({
      repoFullName: 'o/r',
      issueNumber: 1,
      newComments: [{ id: 1, author: 'bob', body: 'Malicious content', createdAt: '2026-01-01T00:00:00Z' }],
    });
    assert.ok(content.includes('[UNTRUSTED EXTERNAL CONTENT]'), 'should wrap external content');
  });

  test('buildIssueCommentContent appends trackingInstructions', () => {
    assert.ok(buildIssueCommentContent, 'buildIssueCommentContent should be importable');
    const content = buildIssueCommentContent(
      {
        repoFullName: 'o/r',
        issueNumber: 1,
        newComments: [{ id: 1, author: 'charlie', body: 'A comment', createdAt: '2026-01-01T00:00:00Z' }],
      },
      'Please respond in Chinese',
    );
    assert.ok(content.includes('📌 **Tracking Instructions**'), 'should have instructions header');
    assert.ok(content.includes('Please respond in Chinese'), 'should include instructions text');
  });
});

// ── AC-D3: IssueCommentTaskSpec ───────────────────────────────────

describe('AC-D3: IssueCommentTaskSpec', () => {
  test('createIssueCommentTaskSpec creates a valid TaskSpec', () => {
    assert.ok(createIssueCommentTaskSpec, 'createIssueCommentTaskSpec should be importable');
    const store = new TaskStore();
    const mockRouter = { route: async () => ({ kind: 'skipped', reason: 'test' }) };
    const mockLog = { info: () => {}, error: () => {}, warn: () => {} };

    const spec = createIssueCommentTaskSpec({
      taskStore: store,
      issueCommentRouter: mockRouter,
      fetchComments: async () => [],
      fetchIssueState: async () => 'open',
      log: mockLog,
    });

    assert.strictEqual(spec.id, 'issue-comment');
    assert.strictEqual(spec.profile, 'poller');
    assert.ok(spec.display);
    assert.strictEqual(spec.display.subjectKind, 'issue');
  });

  test('gate returns run=false when no issue_tracking tasks exist', async () => {
    assert.ok(createIssueCommentTaskSpec, 'createIssueCommentTaskSpec should be importable');
    const store = new TaskStore();
    const mockRouter = { route: async () => ({ kind: 'skipped', reason: 'test' }) };
    const mockLog = { info: () => {}, error: () => {}, warn: () => {} };

    const spec = createIssueCommentTaskSpec({
      taskStore: store,
      issueCommentRouter: mockRouter,
      fetchComments: async () => [],
      fetchIssueState: async () => 'open',
      log: mockLog,
    });

    const result = await spec.admission.gate();
    assert.strictEqual(result.run, false);
  });

  test('gate detects new comments and returns workItems', async () => {
    assert.ok(createIssueCommentTaskSpec, 'createIssueCommentTaskSpec should be importable');
    const store = new TaskStore();
    store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#42',
      title: 'Issue #42',
      why: 'track',
      createdBy: 'cat1',
      userId: 'u1',
    });

    const mockRouter = {
      route: async () => ({ kind: 'notified', threadId: 't1', catId: 'cat1', messageId: 'm1', content: 'test' }),
    };
    const mockLog = { info: () => {}, error: () => {}, warn: () => {} };

    const spec = createIssueCommentTaskSpec({
      taskStore: store,
      issueCommentRouter: mockRouter,
      fetchComments: async () => [{ id: 100, author: 'alice', body: 'New comment', createdAt: '2026-01-01T00:00:00Z' }],
      fetchIssueState: async () => 'open',
      log: mockLog,
    });

    const result = await spec.admission.gate();
    assert.strictEqual(result.run, true);
    assert.ok(result.workItems?.length > 0, 'should have work items');
  });
});

// ── AC-D4: Auto-close on issue closed ─────────────────────────────

describe('AC-D4: Issue auto-close', () => {
  test('gate marks task as done when issue is closed', async () => {
    assert.ok(createIssueCommentTaskSpec, 'createIssueCommentTaskSpec should be importable');
    const store = new TaskStore();
    const task = store.upsertBySubject({
      kind: 'issue_tracking',
      threadId: 't1',
      subjectKey: 'issue:o/r#99',
      title: 'Issue #99',
      why: 'track',
      createdBy: 'cat1',
    });

    const mockRouter = { route: async () => ({ kind: 'skipped', reason: 'test' }) };
    const mockLog = { info: () => {}, error: () => {}, warn: () => {} };

    const spec = createIssueCommentTaskSpec({
      taskStore: store,
      issueCommentRouter: mockRouter,
      fetchComments: async () => [],
      fetchIssueState: async () => 'closed',
      log: mockLog,
    });

    await spec.admission.gate();

    const updated = store.get(task.id);
    assert.strictEqual(updated.status, 'done', 'task should be marked done when issue is closed');
  });
});

// ── Schedule factory registration ─────────────────────────────────

describe('Issue tracking schedule factory', () => {
  test('registerGitHubScheduleFactories registers issue-tracking factory', () => {
    assert.ok(registerGitHubScheduleFactories, 'should be importable');
    const registered = new Map();
    const mockRegistry = {
      register(factory) {
        registered.set(factory.factoryId, factory);
      },
    };
    registerGitHubScheduleFactories(mockRegistry);
    assert.ok(registered.has('github.issue-tracking'), 'should register github.issue-tracking factory');
  });
});
