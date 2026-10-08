import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackExternalReviewTransferRoute } from '../src/routes/callback-external-review-transfer-route.js';
import { fixture } from './f168-reviewer-transfer-fixture.js';

const payload = { repoFullName: 'acme/widgets', prNumber: 7, expectedAssignmentRevision: 0 };
async function appFor(mode: 'source' | 'target' | 'agent' | 'unauthenticated') {
  const f = fixture();
  await f.seed();
  const app = Fastify();
  app.decorateRequest('callbackAuth', null);
  // The shared callback-auth hook owns token validation. This shim supplies its trusted result.
  app.addHook('preHandler', async (request) => {
    if (mode === 'unauthenticated') return;
    request.callbackAuth = {
      ...f.input.principal,
      threadId: mode === 'target' ? f.task.threadId : f.input.principal.threadId,
      invocationId: mode === 'agent' ? undefined : 'inv-1',
    } as InvocationRecord;
  });
  registerCallbackExternalReviewTransferRoute(app, f.service);
  return { app, f };
}

for (const mode of ['unauthenticated', 'agent'] as const) {
  test(`route denies ${mode} calls before authority mutation`, async () => {
    const { app, f } = await appFor(mode);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/callbacks/transfer-external-review', payload });
      assert.equal(response.statusCode, mode === 'agent' ? 403 : 401);
      assert.equal(f.events.length, 3);
    } finally {
      await app.close();
    }
  });
}

test('real callback route transfers assigned source and rejects caller-authored target identity', async () => {
  const { app, f } = await appFor('source');
  try {
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/transfer-external-review',
      payload: { ...payload, targetThreadId: 'forged-thread', principal: f.input.principal },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(f.events.length, 3);
    const response = await app.inject({ method: 'POST', url: '/api/callbacks/transfer-external-review', payload });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().reviewer.threadId, f.task.threadId);
  } finally {
    await app.close();
  }
});

test('approved target route returns canonical receipt; unapproved target fails', async () => {
  const { app, f } = await appFor('target');
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/callbacks/transfer-external-review', payload });
    assert.equal(denied.statusCode, 403);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/transfer-external-review',
      payload: { ...payload, proposalId: 'p-7' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().assignmentRevision, 1);
    assert.equal(f.events.length, 4);
  } finally {
    await app.close();
  }
});
