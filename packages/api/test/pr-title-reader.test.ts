import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrTitleReader } from '../src/infrastructure/github/pr-title-reader.js';

test('PR title cache is short lived and scoped to the original GitHub credential', async () => {
  let token = 'credential-one';
  let now = 0;
  let calls = 0;
  const read = createPrTitleReader({
    getGitHubToken: () => token,
    now: () => now,
    execute: async (args, options) => {
      calls++;
      assert.deepEqual(args.slice(0, 2), ['api', 'repos/owner/repo/pulls/7']);
      assert.equal(options?.ghToken, token);
      return { stdout: JSON.stringify({ number: 7, repository: 'owner/repo', title: `Real title ${calls}` }) };
    },
  });
  const signal = new AbortController().signal;
  assert.equal(await read('owner/repo#7', signal), 'Real title 1');
  assert.equal(await read('owner/repo#7', signal), 'Real title 1');
  token = 'credential-two';
  assert.equal(await read('owner/repo#7', signal), 'Real title 2');
  now += 60_001;
  assert.equal(await read('owner/repo#7', signal), 'Real title 3');
});

test('foreign PR identity or malformed coordinates cannot supply a work title', async () => {
  let calls = 0;
  const read = createPrTitleReader({
    getGitHubToken: () => undefined,
    execute: async () => {
      calls++;
      return { stdout: JSON.stringify({ number: 8, repository: 'other/repo', title: 'Wrong' }) };
    },
  });
  const signal = new AbortController().signal;
  assert.equal(await read('owner/repo#7', signal), null);
  assert.equal(await read('owner/repo#7; echo', signal), null);
  assert.equal(calls, 1);
});
