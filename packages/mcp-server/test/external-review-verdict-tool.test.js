import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';

import {
  externalReviewTransferInputSchema,
  externalReviewVerdictInputSchema,
  externalReviewVerdictTools,
  handleExternalReviewVerdict,
  handleTransferExternalReview,
} from '../dist/tools/external-review-verdict-tool.js';

describe('cat_cafe_record_external_review_verdict', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = {
      apiUrl: process.env.CAT_CAFE_API_URL,
      invocationId: process.env.CAT_CAFE_INVOCATION_ID,
      callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
      credentialFile: process.env.CAT_CAFE_CREDENTIAL_FILE,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'invocation-1';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-1';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv('CAT_CAFE_API_URL', originalEnv.apiUrl);
    restoreEnv('CAT_CAFE_INVOCATION_ID', originalEnv.invocationId);
    restoreEnv('CAT_CAFE_CALLBACK_TOKEN', originalEnv.callbackToken);
    restoreEnv('CAT_CAFE_CREDENTIAL_FILE', originalEnv.credentialFile);
  });

  it('transfer schema and callback preserve the exact subject/revision and derive auth from invocation', async () => {
    const schema = z.object(externalReviewTransferInputSchema).strict();
    const input = {
      repoFullName: 'acme/widgets',
      prNumber: 7,
      expectedAssignmentRevision: 0,
      proposalId: 'proposal-7',
    };
    assert.equal(schema.safeParse({ ...input, targetThreadId: 'forged' }).success, false);
    assert.equal(schema.safeParse({ ...input, expectedAssignmentRevision: -1 }).success, false);
    let sent;
    globalThis.fetch = async (url, options) => {
      sent = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'transferred', assignmentRevision: 1 }),
        text: async () => '{}',
      };
    };
    await handleTransferExternalReview(input);
    assert.match(sent.url, /\/api\/callbacks\/transfer-external-review$/);
    assert.deepEqual(sent.body, input);
    const tool = externalReviewVerdictTools.find((t) => t.name === 'cat_cafe_transfer_external_review');
    assert(tool);
    for (const marker of ['Use when:', 'NOT for:', 'Output:', 'GOTCHA:']) assert(tool.description.includes(marker));
  });

  it('has no naked-verdict schema branch', () => {
    const schema = z.object(externalReviewVerdictInputSchema);
    const naked = schema.safeParse({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      reviewedHeadSha: 'head-current',
      verdict: 'approved',
      summary: 'LGTM',
    });
    assert.equal(naked.success, false);

    const pending = schema.safeParse({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      reviewedHeadSha: 'head-current',
      verdict: 'changes_requested',
      summary: 'Blocking finding remains.',
      delivery: { kind: 'pending_delivery', reason: 'GitHub write unavailable' },
    });
    assert.equal(pending.success, true);
  });

  it('posts one atomic verdict + delivery packet to the invocation-bound callback', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      const body = {
        subjectKey: 'pr:acme/widgets#7',
        lifecycle: 'delivered',
        delivery: { kind: 'delivered' },
      };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };

    const result = await handleExternalReviewVerdict({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      reviewedHeadSha: 'head-current',
      verdict: 'approved',
      summary: 'Current HEAD is clean.',
      userNudgeRequired: true,
      delivery: {
        kind: 'delivered',
        githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-100',
      },
    });

    assert.match(result.content[0].text, /"lifecycle":"delivered"/);
    assert.equal(requests[0].url, 'http://127.0.0.1:3003/api/callbacks/record-external-review-verdict');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      repoFullName: 'acme/widgets',
      prNumber: 7,
      reviewedHeadSha: 'head-current',
      verdict: 'approved',
      summary: 'Current HEAD is clean.',
      userNudgeRequired: true,
      delivery: {
        kind: 'delivered',
        githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-100',
      },
    });
    assert.equal(requests[0].options.headers['x-invocation-id'], 'invocation-1');
  });

  it('description carries use, exclusion, output, and custody gotchas', () => {
    const description = externalReviewVerdictTools[0].description;
    assert.match(description, /Use when:/);
    assert.match(description, /NOT for:/);
    assert.match(description, /Output:/);
    assert.match(description, /GOTCHA:/);
    assert.match(description, /pending_delivery/);
    assert.match(description, /pending_verification/);
    assert.match(description, /without a retry call/);
    assert.match(description, /fail-closed/);
  });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
