/**
 * #1392 AC-7 — Transparent tracking-preview helper.
 *
 * Two layers:
 *  (A) Pure expansion (buildTrackingPreview): every typed intent × pr/issue,
 *      audience provenance, and the fail-closed gate (empty / >20 / unresolved
 *      team). Proves expanded.args passes the canonical register predicate schema.
 *  (B) Live route (POST /api/callbacks/preview-github-tracking) via Fastify
 *      inject: callback auth, GitHub-read wiring, and the hard invariant that
 *      preview writes NO TaskStore and freezes NO baseline.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import {
  githubIssueWaitPredicatesSchema,
  githubWaitPredicatesSchema,
} from '../dist/domains/github-signals/GitHubWaitPredicateCatalog.js';
import { buildTrackingPreview } from '../dist/domains/github-signals/github-tracking-preview.js';

const prSubject = (overrides = {}) => ({ kind: 'pr', repoFullName: 'owner/repo', number: 7, ...overrides });
const issueSubject = (overrides = {}) => ({ kind: 'issue', repoFullName: 'owner/repo', number: 42, ...overrides });

describe('#1392 AC-7 pure expansion — buildTrackingPreview', () => {
  test('wait_for_author_update (PR): head + author-scoped conversation comment', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_author_update', subject: prSubject() },
      { author: 'alice', requestedUsers: [], requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal(result.status, 'register_ready');
    assert.equal(result.baselineFrozen, false);
    assert.equal(result.expanded.registerTool, 'register_pr_tracking');
    assert.deepEqual(result.expanded.args.when, [
      { kind: 'pr_head_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['alice'] },
    ]);
    assert.equal(result.expanded.args.autoRenew, true);
    assert.equal(result.expanded.args.prNumber, 7);
    assert.deepEqual(result.resolvedAudience.authorLogins, ['alice']);
  });

  test('wait_for_author_update (Issue): author-scoped issue comment only', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_author_update', subject: issueSubject() },
      { author: 'bob', assignees: [] },
    );
    assert.equal(result.status, 'register_ready');
    assert.equal(result.expanded.registerTool, 'register_issue_tracking');
    assert.deepEqual(result.expanded.args.when, [{ kind: 'issue_comment_added', authorLogins: ['bob'] }]);
    assert.equal(result.expanded.args.issueNumber, 42);
  });

  test('wait_for_reviewer_response (PR): decision-change arm + requested ∪ prior ∪ caller comment scope', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject(), additionalLogins: ['Erin'] },
      {
        author: 'alice',
        requestedUsers: ['carol'],
        requestedTeams: [],
        priorReviewAuthors: ['dave', 'Carol', 'carol'],
      },
    );
    assert.equal(result.status, 'register_ready');
    // #1392 AC-7 P1 (sol): a bare approve/request-changes (no comment body) surfaces
    // as pr_review_decision_changed; conversation comments stay audience-scoped.
    assert.deepEqual(result.expanded.args.when, [
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['carol', 'dave', 'Erin'] },
    ]);
    const sourceKinds = result.resolvedAudience.sources.map((s) => s.source);
    assert.deepEqual(sourceKinds, ['requested_reviewers', 'prior_review_authors', 'caller_input']);
  });

  test('P2-A overrideLogins: exact replacement narrows an overflow to register_ready', () => {
    const many = Array.from({ length: 21 }, (_, i) => `rev${i}`);
    const overflow = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject() },
      { author: 'alice', requestedUsers: many, requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal(overflow.status, 'needs_input'); // 21 auto-resolved → over the cap
    const narrowed = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject(), overrideLogins: ['rev0', 'rev1', 'rev2'] },
      { author: 'alice', requestedUsers: many, requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal(narrowed.status, 'register_ready');
    assert.deepEqual(narrowed.expanded.args.when, [
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['rev0', 'rev1', 'rev2'] },
    ]);
    assert.deepEqual(
      narrowed.resolvedAudience.sources.map((s) => s.source),
      ['exact_override'],
    );
  });

  test('P2-A overrideLogins bypasses an unresolved team (caller took exact control)', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject(), overrideLogins: ['carol'] },
      { author: 'alice', requestedUsers: [], requestedTeams: ['frontend'], priorReviewAuthors: [] },
    );
    assert.equal(result.status, 'register_ready');
    assert.deepEqual(result.resolvedAudience.unresolved, {});
  });

  test('wait_for_reviewer_response (Issue): assignee-scoped issue comment', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: issueSubject() },
      { author: 'x', assignees: ['zoe', 'amy'] },
    );
    assert.equal(result.status, 'register_ready');
    assert.deepEqual(result.expanded.args.when, [{ kind: 'issue_comment_added', authorLogins: ['zoe', 'amy'] }]);
  });

  test('fail-closed: unresolved team + no caller logins ⇒ needs_input, no expanded', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject() },
      { author: 'alice', requestedUsers: ['carol'], requestedTeams: ['frontend'], priorReviewAuthors: [] },
    );
    assert.equal(result.status, 'needs_input');
    assert.equal(result.expanded, undefined);
    assert.deepEqual(result.resolvedAudience.unresolved.teams, ['frontend']);
    // The resolvable individuals are still surfaced as a hint.
    assert.deepEqual(result.resolvedAudience.authorLogins, ['carol']);
  });

  test('team acknowledged via exact additionalLogins ⇒ register_ready, team stays informational', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject(), additionalLogins: ['helen'] },
      { author: 'alice', requestedUsers: ['carol'], requestedTeams: ['frontend'], priorReviewAuthors: [] },
    );
    assert.equal(result.status, 'register_ready');
    assert.deepEqual(result.expanded.args.when, [
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['carol', 'helen'] },
    ]);
    assert.deepEqual(result.resolvedAudience.unresolved.teams, ['frontend']);
  });

  test('fail-closed: empty resolved audience ⇒ needs_input', () => {
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: issueSubject() },
      { author: 'x', assignees: [] },
    );
    assert.equal(result.status, 'needs_input');
    assert.equal(result.expanded, undefined);
  });

  test('fail-closed: >20 resolved logins ⇒ needs_input (never truncate)', () => {
    const many = Array.from({ length: 21 }, (_, i) => `rev${i}`);
    const result = buildTrackingPreview(
      { intent: 'wait_for_reviewer_response', subject: prSubject() },
      { author: 'alice', requestedUsers: many, requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal(result.status, 'needs_input');
    assert.equal(result.expanded, undefined);
    assert.match(result.humanSummary, /21 logins/);
  });

  test('expiresAt is passed through as-is; then overrides the default continuation', () => {
    const at = Date.now() + 3_600_000;
    const withExtras = buildTrackingPreview(
      { intent: 'wait_for_author_update', subject: prSubject(), expiresAt: at, nextStep: 'Custom follow-up.' },
      { author: 'alice', requestedUsers: [], requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal(withExtras.expanded.args.expiresAt, at);
    assert.equal(withExtras.expanded.args.nextStep, 'Custom follow-up.');
    // Omitted ⇒ no expiresAt key and a default suggestion.
    const withoutExtras = buildTrackingPreview(
      { intent: 'wait_for_author_update', subject: prSubject() },
      { author: 'alice', requestedUsers: [], requestedTeams: [], priorReviewAuthors: [] },
    );
    assert.equal('expiresAt' in withoutExtras.expanded.args, false);
    assert.equal(typeof withoutExtras.expanded.args.nextStep, 'string');
    assert.ok(withoutExtras.expanded.args.nextStep.length > 0);
  });

  test('expanded.args passes the canonical register predicate schema (feedable AS-IS)', () => {
    const prCases = [
      buildTrackingPreview(
        { intent: 'wait_for_author_update', subject: prSubject() },
        { author: 'alice', requestedUsers: [], requestedTeams: [], priorReviewAuthors: [] },
      ),
      buildTrackingPreview(
        { intent: 'wait_for_reviewer_response', subject: prSubject(), additionalLogins: ['erin'] },
        { author: 'alice', requestedUsers: ['carol'], requestedTeams: [], priorReviewAuthors: ['dave'] },
      ),
    ];
    for (const c of prCases) {
      assert.equal(c.status, 'register_ready');
      assert.doesNotThrow(() => githubWaitPredicatesSchema.parse(c.expanded.args.when));
    }
    const issueCases = [
      buildTrackingPreview(
        { intent: 'wait_for_author_update', subject: issueSubject() },
        { author: 'bob', assignees: [] },
      ),
    ];
    for (const c of issueCases) {
      assert.equal(c.status, 'register_ready');
      assert.doesNotThrow(() => githubIssueWaitPredicatesSchema.parse(c.expanded.args.when));
    }
  });
});

describe('#1392 AC-7 live route — POST /api/callbacks/preview-github-tracking', () => {
  let registry;
  let taskStore;
  let threadStore;
  let baseDeps;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    registry = new InvocationRegistry();
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    baseDeps = {
      registry,
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, getMessages: () => [] },
      threadStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: {
        submit: async (m) => ({ id: 'mk', createdAt: '', ...m }),
        list: async () => [],
        transition: async () => {},
      },
      taskStore,
    };
  });

  async function createApp(overrides = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, { ...baseDeps, ...overrides });
    return app;
  }

  const stubReader = {
    pr: async () => ({ author: 'alice', requestedUsers: ['carol'], requestedTeams: [], priorReviewAuthors: ['dave'] }),
    issue: async () => ({ author: 'bob', assignees: ['zoe'] }),
  };

  async function authHeaders(threadName = 'preview-thread') {
    const thread = await threadStore.create('user-1', threadName);
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    return { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  }

  test('resolves a PR reviewer audience and returns a register-ready payload WITHOUT writing TaskStore', async () => {
    const app = await createApp({ fetchGitHubTrackingAudience: stubReader });
    const headers = await authHeaders();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      headers,
      payload: { intent: 'wait_for_reviewer_response', subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 } },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'register_ready');
    assert.equal(body.baselineFrozen, false);
    assert.deepEqual(body.expanded.args.when, [
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['carol', 'dave'] },
    ]);
    // Hard invariant: preview freezes no baseline and installs no task.
    assert.equal(taskStore.size, 0, 'preview must not write TaskStore');
    assert.equal(taskStore.getBySubject('pr:owner/repo#7'), null);
  });

  test('missing GitHub reader for a read-requiring intent ⇒ 503 (never degrades to anyone)', async () => {
    const app = await createApp(); // no reader
    const headers = await authHeaders();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      headers,
      payload: { intent: 'wait_for_author_update', subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 } },
    });
    assert.equal(response.statusCode, 503);
  });

  test('GitHub read failure ⇒ 503 (fail-closed)', async () => {
    const app = await createApp({
      fetchGitHubTrackingAudience: {
        pr: async () => {
          throw new Error('gh boom');
        },
        issue: async () => ({ author: 'b', assignees: [] }),
      },
    });
    const headers = await authHeaders();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      headers,
      payload: { intent: 'wait_for_author_update', subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 } },
    });
    assert.equal(response.statusCode, 503);
  });

  test('rejects a past expiresAt and requires callback auth', async () => {
    const app = await createApp({ fetchGitHubTrackingAudience: stubReader });
    const headers = await authHeaders();
    const past = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      headers,
      payload: {
        intent: 'wait_for_reviewer_response',
        subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 },
        additionalLogins: ['fred'],
        expiresAt: Date.now() - 1000,
      },
    });
    assert.equal(past.statusCode, 400);

    const unauth = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      payload: {
        intent: 'wait_for_reviewer_response',
        subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 },
        additionalLogins: ['fred'],
      },
    });
    assert.equal(
      unauth.statusCode === 401 || unauth.statusCode === 400,
      true,
      'unauthenticated preview must be rejected',
    );
  });
});
