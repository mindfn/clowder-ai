import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 proposal runtime — no server-side PR inference', () => {
  test('preserves the caller-supplied initialMessage verbatim for clowder-ai PR references', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        reason: 'Review https://github.com/zts212653/clowder-ai/pull/1192 in a dedicated thread',
        initialMessage: 'Own this PR and close the loop.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, 'Own this PR and close the loop.');
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('delivers a lossless source envelope to the child thread when initialMessage is omitted', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const reason = 'Evaluate the existing community contribution.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'clowder-ai PR #1189 intake review',
        reason,
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, undefined);
    assert.equal(proposal.communityPrContext, undefined);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1, 'child thread must receive a seed message even without initialMessage');
    const seed = timeline[0];
    assert.ok(seed.content.includes(reason), 'seed message must include the original reason');
    assert.ok(
      seed.content.includes('clowder-ai PR #1189 intake review'),
      'seed message must include the original title',
    );
    assert.ok(seed.content.includes('## 主 Thread'), 'seed message must still include the fork-and-return header');
    // The proposal record stores the raw (undefined) initialMessage, not the envelope.
    assert.equal(proposal.initialMessage, undefined);
  });

  test('delivers reason-only PR URL to the child thread as a verifiable source envelope', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const url = 'https://github.com/zts212653/clowder-ai/pull/1196';
    const reason = `Advisory review of ${url} only.`;

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Advisory discussion',
        reason,
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes(url), 'child must be able to read the PR URL from the source envelope');
    assert.ok(seed.content.includes('Advisory discussion'), 'seed message must include the original title');
    assert.ok(seed.content.includes('## 主 Thread'), 'seed message must include the fork-and-return header');
  });

  test('does not treat repo-qualified shorthand as a PR without explicit review intent', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: 'Triage clowder-ai#1195',
        reason: 'Inspect the new community issue.',
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, undefined);
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('leaves advisory, triage, arbitrary-link, and multi-PR proposals untouched', async () => {
    for (const body of [
      {
        title: 'Advisory discussion',
        reason: 'Advisory review of https://github.com/zts212653/clowder-ai/pull/1196 only.',
      },
      {
        title: 'Triage inbound link',
        reason: 'Triage https://github.com/zts212653/clowder-ai/pull/1197 before deciding whether review is needed.',
      },
      {
        title: 'Reference material',
        reason: 'Keep https://github.com/zts212653/clowder-ai/pull/1198 as context.',
      },
      {
        title: 'Formal review batch',
        reason:
          'Review https://github.com/zts212653/clowder-ai/pull/1199 and https://github.com/zts212653/clowder-ai/pull/1200.',
      },
    ]) {
      const ctx = await createProposalTestContext();
      const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
      const res = await ctx.propose({ userId: 'alice', threadId: source.id, body });

      assert.equal(res.statusCode, 200);
      const proposal = await ctx.proposalStore.get(JSON.parse(res.body).proposalId);
      assert.equal(proposal.initialMessage, undefined);
      assert.equal(proposal.communityPrContext, undefined);
    }
  });

  test('does not rewrite an unrelated internal proposal', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Internal work');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { initialMessage: 'Investigate the internal queue race.' },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.initialMessage, 'Investigate the internal queue race.');
    assert.equal(proposal.communityPrContext, undefined);
  });

  test('treats empty-string initialMessage as absent and falls back to source envelope', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const reason = 'Empty-string override must still deliver the source envelope.';

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Envelope fallback', reason, initialMessage: '' },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    assert.ok(timeline[0].content.includes(reason), 'empty-string initialMessage must fall back to envelope content');
  });

  test('does not let @-mentions or #ideate inside title/reason influence routing', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const resolveCalls = [];
    const router = {
      async resolveTargetsAndIntent(content, threadId, options) {
        resolveCalls.push({ content, threadId, options });
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: new InvocationQueue(),
      queueProcessorOverride: {
        async processNext() {
          return { started: true };
        },
      },
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: {
        title: '@opus please review',
        reason: '#ideate discuss this PR',
        preferredCats: ['kimi'],
      },
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);

    assert.equal(resolveCalls.length, 1, 'router must be consulted during approve dispatch');
    assert.equal(
      resolveCalls[0].content,
      '',
      'routing input must be empty when no explicit initialMessage is provided; title/reason must not leak',
    );

    const { threadId } = JSON.parse(approveRes.body);
    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes('@opus'), 'seed content may contain the title text');
    assert.ok(seed.content.includes('#ideate'), 'seed content may contain the reason text');
    // The seed must still be serial (preferredCats[0] only) despite #ideate in reason.
    assert.deepEqual(seed.mentions, ['kimi'], 'preferredCats[0] wins; #ideate in reason must not flip to parallel');
  });

  test('carries structured content blocks from the source message into the child seed', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const ctx = await createProposalTestContext({
      invocationQueueOverride: new InvocationQueue(),
      queueProcessorOverride: {
        async processNext() {
          return { started: true };
        },
      },
    });
    const source = await ctx.threadStore.create('alice', 'Community gatekeeper');
    const contentBlocks = [
      {
        type: 'file',
        url: 'https://example.com/fix.patch',
        fileName: 'fix.patch',
        mimeType: 'text/x-diff',
        fileSize: 123,
      },
    ];

    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Patch review', reason: 'Please review the attached patch.' },
      originContentBlocks: contentBlocks,
    });

    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.ok(proposal.sourceMessageId, 'proposal must record the source message id');

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const { threadId } = JSON.parse(approveRes.body);

    const timeline = await ctx.messageStore.getByThread(threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
    });
    assert.equal(timeline.length, 1);
    const seed = timeline[0];
    assert.ok(seed.content.includes('Patch review'), 'seed text must include title');
    assert.deepEqual(seed.contentBlocks, contentBlocks, 'seed must preserve source message content blocks losslessly');
    assert.ok(
      seed.content.includes(proposal.sourceMessageId),
      'seed text must expose the exact sourceMessageId so the child can dereference it',
    );
  });
});
