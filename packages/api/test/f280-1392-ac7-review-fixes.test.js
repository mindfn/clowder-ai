/**
 * #1392 AC-7 — sol re-review fixes (exact HEAD after 228b40954).
 *
 *  P1-C: production audience reader paginates /reviews (no page-2 drop).
 *  P1-B: reply_and_wait choreography — preview→REAL register installs an active
 *        generation; a post-reply register failure is the LOUD partial status,
 *        never a generic 4xx/5xx.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import {
  createGitHubTrackingAudienceReader,
  parsePaginatedReviewLogins,
} from '../dist/domains/github-signals/github-tracking-audience-reader.js';

describe('#1392 AC-7 P1-C — audience reader pagination (production reader, not pre-injected arrays)', () => {
  test('parsePaginatedReviewLogins merges every page of {login} output', () => {
    const lines = Array.from({ length: 45 }, (_, i) => JSON.stringify({ login: `rev${i}` }));
    const parsed = parsePaginatedReviewLogins(lines.join('\n'));
    assert.equal(parsed.length, 45);
    assert.equal(parsed[44], 'rev44'); // a page-2 reviewer survives
  });

  test('parsePaginatedReviewLogins skips blanks and null logins', () => {
    const out = [
      JSON.stringify({ login: 'a' }),
      '',
      JSON.stringify({ login: null }),
      JSON.stringify({ login: 'b' }),
    ].join('\n');
    assert.deepEqual(parsePaginatedReviewLogins(out), ['a', 'b']);
  });

  test('production PR reader fetches /reviews with --paginate and captures all pages (no 30-cap)', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push([...args]);
      const joined = args.join(' ');
      if (joined.includes('/reviews')) {
        // 40 reviewers — a single default page would silently cap this at 30.
        return Array.from({ length: 40 }, (_, i) => JSON.stringify({ login: `r${i}` })).join('\n');
      }
      if (joined.includes('/requested_reviewers')) return JSON.stringify({ users: ['req1'], teams: ['team-a'] });
      return JSON.stringify({ author: 'author1' }); // /pulls/{n}
    };
    const reader = createGitHubTrackingAudienceReader(gh);
    const audience = await reader.pr('owner/repo', 7);
    assert.equal(audience.priorReviewAuthors.length, 40, 'all 40 review authors captured');
    const reviewsCall = calls.find((a) => a.join(' ').includes('/reviews'));
    assert.ok(reviewsCall?.includes('--paginate'), '/reviews MUST be fetched with --paginate');
    assert.equal(audience.author, 'author1');
    assert.deepEqual(audience.requestedUsers, ['req1']);
    assert.deepEqual(audience.requestedTeams, ['team-a']);
  });

  test('production issue reader returns author + assignees', async () => {
    const reader = createGitHubTrackingAudienceReader(async () =>
      JSON.stringify({ author: 'iauthor', assignees: ['asg1', 'asg2'] }),
    );
    assert.deepEqual(await reader.issue('owner/repo', 42), { author: 'iauthor', assignees: ['asg1', 'asg2'] });
  });
});

describe('#1392 AC-7 P1-B — reply_and_wait preview→register choreography', () => {
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
    await app.register(callbacksRoutes, {
      ...baseDeps,
      fetchPrWaitBaseline: async () => ({ baseline: { capturedAt: 100, headSha: 'head-1' }, collectorState: {} }),
      ...overrides,
    });
    return app;
  }

  async function authHeaders() {
    const thread = await threadStore.create('user-1', 'reply-and-wait-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    return { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  }

  test('preview reply_and_wait → REAL register installs an active single-fire generation', async () => {
    const app = await createApp();
    const headers = await authHeaders();
    const preview = await app.inject({
      method: 'POST',
      url: '/api/callbacks/preview-github-tracking',
      headers,
      payload: {
        intent: 'reply_and_wait',
        subject: { kind: 'pr', repoFullName: 'owner/repo', number: 7 },
        additionalLogins: ['fred'],
      },
    });
    const previewBody = JSON.parse(preview.body);
    assert.equal(previewBody.status, 'register_ready');

    // Feed expanded.args AS-IS to the existing register tool.
    const register = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers,
      payload: previewBody.expanded.args,
    });
    assert.equal(register.statusCode, 200);
    const registerBody = JSON.parse(register.body);
    assert.equal(registerBody.status, 'ok');
    // The demo proof: a real active generation exists after register.
    assert.ok(registerBody.await.generation >= 1, 'active generation must exist after successful register');
    assert.equal(registerBody.await.autoRenew, false, 'reply_and_wait is FIXED single-fire');
    assert.ok(taskStore.getBySubject('pr:owner/repo#7'), 'tracking task installed');
  });

  test('reply already sent + register install fails → reply_succeeded_tracking_not_armed (200, not a generic 5xx)', async () => {
    const app = await createApp({
      fetchPrWaitBaseline: async () => {
        throw new Error('baseline store down');
      },
    });
    const headers = await authHeaders();
    const register = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers,
      payload: {
        repoFullName: 'owner/repo',
        prNumber: 7,
        when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['fred'] }],
        nextStep: 'Read their reply.',
        autoRenew: false,
        replyAlreadySent: true,
      },
    });
    assert.equal(register.statusCode, 200, 'partial status is NOT a generic 4xx/5xx');
    const body = JSON.parse(register.body);
    assert.equal(body.status, 'reply_succeeded_tracking_not_armed');
    assert.equal(body.registerError.statusCode, 503, 'the underlying install failure is preserved for diagnosis');
    assert.equal(taskStore.size, 0, 'no generation installed on failure');
  });

  test('WITHOUT replyAlreadySent the identical failure stays a generic 503', async () => {
    const app = await createApp({
      fetchPrWaitBaseline: async () => {
        throw new Error('baseline store down');
      },
    });
    const headers = await authHeaders();
    const register = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers,
      payload: {
        repoFullName: 'owner/repo',
        prNumber: 7,
        when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['fred'] }],
        nextStep: 'Read their reply.',
        autoRenew: false,
      },
    });
    assert.equal(register.statusCode, 503);
    assert.equal(JSON.parse(register.body).status, undefined);
  });
});
