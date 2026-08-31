import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { hydrateProposal } from '../dist/domains/cats/services/stores/redis/RedisProposalStoreHelpers.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

function makeTempProjectPath() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-proposal-transition-')));
}

async function proposeExternal(ctx, source, preferredCats = ['opus'], projectPath) {
  const response = await ctx.propose({
    userId: 'alice',
    threadId: source.id,
    body: {
      title: 'Exact-HEAD review for clowder-ai PR #1210',
      reason: 'Review https://github.com/zts212653/clowder-ai/pull/1210 in an owner child.',
      initialMessage: 'Perform an independent exact-HEAD review; findings return to the external author.',
      preferredCats,
      projectPath,
      reportingMode: 'final-only',
    },
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body).proposalId;
}

describe('F128 approval — no automatic external PR metadata or tracking', () => {
  test('approval creates the thread but does not write PR metadata or tracking', async () => {
    const projectPath = makeTempProjectPath();
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const proposalId = await proposeExternal(ctx, source, ['opus'], projectPath);

    const approved = await ctx.approve('alice', proposalId);
    assert.equal(approved.statusCode, 200);
    const { threadId, warnings } = JSON.parse(approved.body);
    assert.ok(threadId);
    assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
    assert.ok(
      !warnings ||
        warnings.length === 0 ||
        warnings.every((w) => /routing dependencies unavailable|no target cats resolved/i.test(w)),
      `unexpected warnings: ${JSON.stringify(warnings)}`,
    );

    const thread = await ctx.threadStore.get(threadId);
    assert.deepEqual(thread.preferredCats, ['opus']);
    assert.equal(thread.projectPath, projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  });

  test('zero or multiple preferredCats are passed through without owner-custody warnings', async () => {
    const projectPath = makeTempProjectPath();
    try {
      for (const preferredCats of [[], ['opus', 'codex']]) {
        const ctx = await createProposalTestContext();
        const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
        const proposalId = await proposeExternal(ctx, source, preferredCats, projectPath);
        const approved = await ctx.approve('alice', proposalId);
        const { threadId, warnings } = JSON.parse(approved.body);
        assert.ok(threadId);
        assert.ok(!warnings || !warnings.some((w) => /exactly one.*owner/i.test(w)));
        assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
        assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
      }
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('advisory and formal-looking proposals are approved identically with no tracking side effects', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const response = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Community context',
        reason: 'Advisory discussion of https://github.com/zts212653/clowder-ai/pull/1210 only.',
        preferredCats: ['opus'],
      },
    });
    const approved = await ctx.approve('alice', JSON.parse(response.body).proposalId);
    const { threadId } = JSON.parse(approved.body);
    assert.equal(await ctx.threadStore.getThreadMetadata(threadId), null);
    assert.equal(await ctx.taskStore.getBySubject('pr:zts212653/clowder-ai#1210'), null);
  });

  test('legacy communityPrContext field is ignored during Redis proposal hydration', () => {
    const proposal = hydrateProposal({
      proposalId: 'prop_legacy_001',
      status: 'pending',
      sourceThreadId: 'thread_src',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      sourceMessageId: 'msg_1',
      title: 'Legacy proposal',
      reason: 'Has an obsolete communityPrContext field.',
      parentThreadId: 'thread_src',
      preferredCats: '[]',
      projectPath: 'default',
      createdBy: 'alice',
      createdAt: '1700000000000',
      communityPrContext: JSON.stringify({ repo: 'zts212653/clowder-ai', number: 42 }),
    });
    assert.equal(proposal.communityPrContext, undefined, 'obsolete field must be dropped');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.title, 'Legacy proposal');
    assert.equal(proposal.sourceMessageId, 'msg_1');
  });
});
