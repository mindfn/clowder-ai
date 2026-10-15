import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
const subjectKey = 'pr:acme/widgets#7';
describe('reviewer transfer atomic authority reads (real Redis)', { skip: redisIsolationSkipReason(redisUrl) }, () => {
  let redis;
  let classes;
  before(async () => {
    assertRedisIsolationOrThrow(redisUrl, 'reviewer transfer authority');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient(redisUrl);
    await redis.ping();
    const paths = [
      'cats/services/stores/redis/RedisTaskStore',
      'cats/services/stores/redis/RedisThreadStore',
      'cats/services/stores/redis/RedisProposalStore',
      'cats/services/agents/invocation/RedisAuthInvocationBackend',
      'community/CommunityEventLog',
      'community/CommunityObjectStore',
      'community/community-projector',
      'community/external-review/ExternalReviewTransferService',
    ];
    const modules = await Promise.all(paths.map((p) => import(`../dist/domains/${p}.js`)));
    classes = Object.assign({}, ...modules);
  });
  after(async () => {
    if (redis) await redis.quit();
  });
  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, [
      'community:*',
      'task:*',
      'tasks:*',
      'thread:*',
      'threads:*',
      'proposal:*',
      'proposals:*',
      'auth:*',
    ]);
  });

  async function setup(approved = false) {
    const threads = new classes.RedisThreadStore(redis);
    const tasks = new classes.RedisTaskStore(redis);
    const proposals = new classes.RedisProposalStore(redis);
    const auth = new classes.RedisAuthInvocationBackend(redis);
    const eventLog = new classes.RedisCommunityEventLog(redis);
    const objectStore = new classes.RedisCommunityObjectStore(redis);
    const projector = new classes.CommunityProjector(eventLog, objectStore);
    const source = await threads.create('user-1', 'source');
    const target = await threads.create('user-1', 'target');
    const task = await tasks.create({
      kind: 'pr_tracking',
      subjectKey,
      threadId: target.id,
      ownerCatId: 'codex',
      userId: 'user-1',
      createdBy: 'codex',
      title: 'PR',
      why: 'tracking',
    });
    const principal = {
      invocationId: 'inv-1',
      catId: 'codex',
      userId: 'user-1',
      threadId: approved ? target.id : source.id,
    };
    const invocation = { ...principal, callbackToken: 'test-token', createdAt: 1, clientMessageIds: new Set() };
    await auth.create(invocation);
    let proposal;
    if (approved) {
      proposal = await proposals.create({
        sourceThreadId: source.id,
        sourceInvocationId: 'source-inv',
        sourceCatId: 'codex',
        sourceMessageId: 'message-1',
        title: 'Review',
        reason: 'handover',
        parentThreadId: source.id,
        preferredCats: ['codex'],
        projectPath: 'default',
        createdBy: 'user-1',
        subjectTaskId: task.id,
      });
      await proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'user-1' });
      proposal = await proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: target.id });
    }
    for (const [kind, payload] of [
      [
        'case.external_review_assigned',
        { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'codex', reviewerThreadId: source.id },
      ],
      ['case.head_observed', { headSha: 'a'.repeat(40), headGeneration: 1 }],
      ['case.ci_observed', { headSha: 'a'.repeat(40), headGeneration: 1, status: 'pass' }],
    ])
      await eventLog.append({ kind, payload, subjectKey, sourceEventId: kind, at: 1, classification: 'informational' });
    await projector.rebuild(subjectKey);
    const options = {
      eventLog,
      objectStore,
      projector,
      taskStore: tasks,
      threadStore: threads,
      proposalStore: proposals,
      isLatestInvocation: (id) => auth.isLatest(id),
    };
    const service = new classes.ExternalReviewTransferService(options);
    const input = {
      repoFullName: 'acme/widgets',
      prNumber: 7,
      expectedAssignmentRevision: 0,
      principal,
      ...(proposal ? { proposalId: proposal.proposalId } : {}),
    };
    return {
      threads,
      tasks,
      proposals,
      auth,
      eventLog,
      objectStore,
      source,
      target,
      proposal,
      options,
      service,
      input,
      invocation,
    };
  }

  const mutations = [
    { name: 'caller soft deletion', code: 'stale_thread', run: (f) => f.threads.softDelete(f.source.id) },
    { name: 'target soft deletion', code: 'stale_thread', run: (f) => f.threads.softDelete(f.target.id) },
    { name: 'target hard deletion', code: 'stale_thread', run: (f) => f.threads.delete(f.target.id) },
    {
      name: 'target ownership change',
      code: 'stale_thread',
      run: (f) => redis.hset(`thread:${f.target.id}`, 'createdBy', 'other-owner'),
    },
    { name: 'target tombstone', code: 'stale_thread', run: (f) => redis.set(`thread:${f.target.id}:tombstone`, '1') },
    {
      name: 'approval deletion',
      code: 'stale_approval',
      approved: true,
      run: (f) => f.proposals.delete(f.proposal.proposalId),
    },
    {
      name: 'invocation replacement',
      code: 'stale_invocation',
      run: (f) => f.auth.create({ ...f.invocation, invocationId: 'inv-2' }),
    },
    {
      name: 'invocation termination',
      code: 'stale_invocation',
      run: (f) =>
        f.auth.commitTerminal({
          invocationId: f.invocation.invocationId,
          disposition: 'completed',
          endedAt: 2,
          endReason: 'test',
        }),
    },
  ];
  for (const { name, code, run, approved } of mutations) {
    it(`${name} after validation prevents the canonical transfer append`, async () => {
      const f = await setup(approved);
      let reads = 0;
      f.options.isLatestInvocation = async (id) => {
        const valid = await f.auth.isLatest(id);
        if (++reads === 2) await run(f);
        return valid;
      };
      await assert.rejects(f.service.transfer(f.input), { code });
      assert.equal((await f.eventLog.read(subjectKey)).length, 3);
      assert.equal((await f.objectStore.get(subjectKey)).externalReview.reviewerThreadId, f.source.id);
    });
  }

  it('source and approved-target paths commit and replay idempotently', async () => {
    for (const approved of [false, true]) {
      await cleanupPrefixedRedisKeys(redis, ['community:*', 'task:*', 'tasks:*', 'auth:*']);
      const f = await setup(approved);
      assert.equal((await f.service.transfer(f.input)).reviewer.threadId, f.target.id);
      assert.equal((await f.service.transfer(f.input)).deduped, true);
      assert.equal((await f.eventLog.read(subjectKey)).length, 4);
    }
  });

  it('normal activity and a restored live thread retain authority', async () => {
    const f = await setup();
    let reads = 0;
    f.options.isLatestInvocation = async (id) => {
      const valid = await f.auth.isLatest(id);
      if (++reads === 2) {
        await f.threads.updateTitle(f.target.id, 'updated');
        await f.threads.softDelete(f.target.id);
        await f.threads.restore(f.target.id);
      }
      return valid;
    };
    assert.equal((await f.service.transfer(f.input)).reviewer.threadId, f.target.id);
  });

  it('consumed approval cannot be renewed by a fresh revision after ABA', async () => {
    const f = await setup(true);
    await f.service.transfer(f.input);
    const move = async (threadId) => {
      const task = await f.tasks.getBySubject(subjectKey);
      await f.tasks.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: null,
        automationState: undefined,
        trackingRegistration: { threadId, ownerCatId: 'codex', userId: 'user-1', title: 'PR', why: 'ABA' },
      });
    };
    await move(f.source.id);
    await f.service.transfer({ ...f.input, proposalId: undefined, expectedAssignmentRevision: 1 });
    await move(f.target.id);
    await assert.rejects(f.service.transfer({ ...f.input, expectedAssignmentRevision: 2 }), {
      code: 'approval_consumed',
    });
    assert.equal((await f.objectStore.get(subjectKey)).externalReview.reviewerThreadId, f.source.id);
    assert.equal(
      (await f.proposals.get(f.proposal.proposalId)).status,
      'approved',
      'approval decision remains historical truth',
    );
    assert.equal((await f.eventLog.read(subjectKey)).length, 5);
  });

  it('concurrent delegate retries consume one grant and recover from canonical history', async () => {
    const f = await setup(true);
    const outcomes = await Promise.allSettled([
      f.service.transfer(f.input),
      new classes.ExternalReviewTransferService(f.options).transfer(f.input),
    ]);
    assert(outcomes.some((r) => r.status === 'fulfilled'));
    assert.equal((await f.service.transfer(f.input)).deduped, true);
    const transfers = (await f.eventLog.read(subjectKey)).filter((e) => e.kind === 'case.external_review_reassigned');
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].payload.authority.proposalId, f.proposal.proposalId);
  });
});
