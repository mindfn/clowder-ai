// @ts-check
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { fetchPrCiStatuses } from '../dist/infrastructure/email/ci-status-batch-fetcher.js';

function graphQlPr({ sha, contexts, hasNextPage = false }) {
  return {
    headRefOid: sha,
    state: 'OPEN',
    mergedAt: null,
    mergedBy: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: contexts, pageInfo: { hasNextPage } },
            },
          },
        },
      ],
    },
  };
}

function checkRun(name, conclusion) {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    detailsUrl: `https://example.test/${name}`,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  };
}

describe('fetchPrCiStatuses batch failure isolation', () => {
  it('keeps paginated context completion out of tick admission without inventing a pass', async () => {
    let requests = 0;
    const result = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        deferFailureDetails: true,
        async execFileAsync() {
          requests++;
          return {
            stdout: JSON.stringify({
              data: {
                r0: { p0: graphQlPr({ sha: 'head-long', contexts: [checkRun('gate', 'SUCCESS')], hasNextPage: true }) },
              },
            }),
          };
        },
      },
    );
    assert.equal(requests, 1);
    assert.equal(result.get('owner/repo#7')?.aggregateBucket, 'pending');
    assert.equal(result.get('owner/repo#7')?.fullRollupPending, true);
  });
  it('collects a later healthy batch after the first request exhausts its queue and I/O deadline', async () => {
    let requests = 0;
    const results = await fetchPrCiStatuses(
      Array.from({ length: 21 }, (_, i) => ({ repoFullName: 'owner/repo', prNumber: i + 1 })),
      { warn() {} },
      {
        ghToken: 'ci-stalled-first-batch',
        timeoutMs: 20,
        async execFileAsync(_file, _args, options) {
          if (++requests === 1)
            return new Promise((_resolve, reject) =>
              options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
            );
          return {
            stdout: JSON.stringify({
              data: { r0: { p0: graphQlPr({ sha: 'head-21', contexts: [checkRun('gate', 'SUCCESS')] }) } },
            }),
          };
        },
      },
    );
    assert.equal(requests, 2);
    assert.equal(results.get('owner/repo#1'), null);
    assert.equal(results.get('owner/repo#21')?.aggregateBucket, 'pass');
  });

  it('defers failure detail reads while preserving the raw failure snapshot', async () => {
    const commands = [];
    const result = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        deferFailureDetails: true,
        async execFileAsync(_file, args) {
          commands.push(args);
          return {
            stdout: JSON.stringify({
              data: { r0: { p0: graphQlPr({ sha: 'head-fail', contexts: [checkRun('gate', 'FAILURE')] }) } },
            }),
          };
        },
      },
    );
    assert.equal(commands.length, 1);
    assert.equal(result.get('owner/repo#7')?.aggregateBucket, 'fail');
    assert.equal(result.get('owner/repo#7')?.failureDetailsPending, true);
  });
  it('bounds requests and preserves healthy batches when another batch returns HTTP 504', async () => {
    const targets = Array.from({ length: 45 }, (_, i) => ({ repoFullName: 'owner/repo', prNumber: i + 1 }));
    const requestSizes = [];
    const results = await fetchPrCiStatuses(
      targets,
      { warn() {} },
      {
        ghToken: 'ci-batch-504-isolation',
        async execFileAsync(_file, args) {
          const query = args.find((arg) => arg.startsWith('query='));
          const refs = [...query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)];
          requestSizes.push(refs.length);
          if (requestSizes.length === 1) throw new Error('HTTP 504');
          return {
            stdout: JSON.stringify({
              data: {
                r0: Object.fromEntries(
                  refs.map(([, alias, number]) => [
                    alias,
                    graphQlPr({ sha: `head-${number}`, contexts: [checkRun('gate', 'SUCCESS')] }),
                  ]),
                ),
              },
            }),
          };
        },
      },
    );
    assert.ok(
      requestSizes.every((size) => size <= 20),
      'one request cannot contain hundreds of PRs',
    );
    assert.equal(results.get('owner/repo#1'), null);
    assert.equal(results.get('owner/repo#45')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#45')?.headSha, 'head-45');
  });

  it('binds each rollup and HEAD to its own repo-plus-PR key', async () => {
    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 8 },
      ],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          assert.equal(args[0], 'api');
          return {
            stdout: JSON.stringify({
              data: {
                r0: {
                  p0: graphQlPr({ sha: '7'.repeat(40), contexts: [checkRun('pr-7-gate', 'SUCCESS')] }),
                  p1: graphQlPr({ sha: '8'.repeat(40), contexts: [checkRun('pr-8-gate', null)] }),
                },
              },
            }),
          };
        },
      },
    );

    assert.deepEqual(
      {
        headSha: results.get('owner/repo#7')?.headSha,
        bucket: results.get('owner/repo#7')?.aggregateBucket,
        checks: results.get('owner/repo#7')?.checks.map((check) => check.name),
      },
      { headSha: '7'.repeat(40), bucket: 'pass', checks: ['pr-7-gate'] },
    );
    assert.deepEqual(
      {
        headSha: results.get('owner/repo#8')?.headSha,
        bucket: results.get('owner/repo#8')?.aggregateBucket,
        checks: results.get('owner/repo#8')?.checks.map((check) => check.name),
      },
      { headSha: '8'.repeat(40), bucket: 'pending', checks: ['pr-8-gate'] },
    );
  });

  it('passes cancellation to gh and does not swallow an abort as an empty poll', async () => {
    const controller = new AbortController();
    let commandCount = 0;

    const pending = fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        signal: controller.signal,
        async execFileAsync(_file, _args, options) {
          commandCount++;
          assert(options.signal instanceof AbortSignal);
          controller.abort(new Error('scheduler timeout'));
          assert.equal(options.signal.aborted, true);
          throw controller.signal.reason;
        },
      },
    );

    await assert.rejects(pending, /scheduler timeout/);
    assert.equal(commandCount, 1, 'abort must not start fallback or enrichment gh commands');
  });

  it('keeps healthy PR data when gh exits 1 with partial GraphQL data on stdout', async () => {
    const warnings = [];
    const partial = {
      data: {
        r0: {
          p0: graphQlPr({ sha: 'a'.repeat(40), contexts: [checkRun('gate', 'SUCCESS')] }),
          p1: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', path: ['r0', 'p1'] }],
    };
    const ghError = Object.assign(new Error('gh exited with code 1'), { stdout: JSON.stringify(partial) });

    const results = await fetchPrCiStatuses(
      [
        { repoFullName: 'owner/repo', prNumber: 7 },
        { repoFullName: 'owner/repo', prNumber: 999_999 },
      ],
      { warn: (message) => warnings.push(String(message)) },
      {
        async execFileAsync() {
          throw ghError;
        },
      },
    );

    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pass');
    assert.equal(results.get('owner/repo#999999'), null);
    assert.ok(warnings.some((message) => message.includes('partial errors')));
  });

  it('preserves required-check narrowing when a required check fails', async () => {
    const commands = [];
    const results = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          commands.push([...args]);
          const command = args.join(' ');
          if (command.startsWith('api graphql ')) {
            return {
              stdout: JSON.stringify({
                data: {
                  r0: {
                    p0: graphQlPr({
                      sha: 'b'.repeat(40),
                      contexts: [checkRun('required-gate', 'FAILURE'), checkRun('optional-lint', 'FAILURE')],
                    }),
                  },
                },
              }),
            };
          }
          if (command.startsWith('pr checks ') && command.includes('--required')) {
            return {
              stdout: JSON.stringify([
                {
                  name: 'required-gate',
                  bucket: 'fail',
                  link: 'https://example.test/required-gate',
                  workflow: 'CI',
                },
              ]),
            };
          }
          if (command.includes('/check-runs?')) return { stdout: JSON.stringify({ check_runs: [] }) };
          if (command.includes('/actions/runs?')) return { stdout: JSON.stringify({ workflow_runs: [] }) };
          throw new Error(`unexpected gh command: ${command}`);
        },
      },
    );

    assert.deepEqual(
      results.get('owner/repo#7')?.checks.map((check) => check.name),
      ['required-gate'],
    );
    assert.ok(commands.some((args) => args.includes('--required')));
  });

  it('falls back to the exact single-PR reader when rollup contexts exceed one page', async () => {
    const commands = [];
    const results = await fetchPrCiStatuses(
      [{ repoFullName: 'owner/repo', prNumber: 7 }],
      { warn() {} },
      {
        async execFileAsync(file, args) {
          assert.equal(file, 'gh');
          commands.push([...args]);
          const command = args.join(' ');
          if (command.startsWith('api graphql ')) {
            return {
              stdout: JSON.stringify({
                data: {
                  r0: {
                    p0: graphQlPr({
                      sha: 'c'.repeat(40),
                      contexts: [
                        {
                          __typename: 'CheckRun',
                          name: 'gate',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                        },
                      ],
                      hasNextPage: true,
                    }),
                  },
                },
              }),
            };
          }
          if (command.startsWith('pr view ')) {
            return {
              stdout: JSON.stringify({
                headRefOid: 'c'.repeat(40),
                state: 'OPEN',
                mergedAt: null,
                mergedBy: null,
                statusCheckRollup: [{ name: 'gate', status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' }],
              }),
            };
          }
          throw new Error(`unexpected gh command: ${command}`);
        },
      },
    );

    assert.equal(results.get('owner/repo#7')?.aggregateBucket, 'pending');
    assert.ok(commands.some((args) => args[0] === 'pr' && args[1] === 'view'));
  });
});
