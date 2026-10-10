import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { after, test } from 'node:test';

// Own this file's subprocess boundary: no gh process, network or auth-store read.
const originalExecFile = cp.execFile;
let mode = 'failure';
let calls = [];
let onDetail;
cp.execFile = (_file, args, options, callback) => {
  calls.push({ args, signal: options.signal, token: options.env.GITHUB_TOKEN, ambientToken: options.env.GH_TOKEN });
  const child = new EventEmitter();
  child.kill = () => true;
  if (onDetail && args[0] === 'pr' && args[1] === 'checks') {
    options.signal.addEventListener(
      'abort',
      () => {
        callback(options.signal.reason, '', '');
        child.emit('close', 0);
      },
      { once: true },
    );
    queueMicrotask(onDetail);
    return child;
  }
  const output =
    args[1] === 'graphql'
      ? {
          data: {
            r0: {
              p0: {
                headRefOid: 'exact-head',
                state: 'OPEN',
                mergedAt: null,
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'gate',
                                status: 'COMPLETED',
                                conclusion: mode === 'failure' ? 'FAILURE' : 'SUCCESS',
                              },
                            ],
                            pageInfo: { hasNextPage: mode === 'pagination' },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }
      : args[1] === 'view'
        ? {
            headRefOid: 'exact-head',
            state: 'OPEN',
            mergedAt: null,
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          }
        : args[1] === 'checks'
          ? [{ name: 'gate', bucket: mode === 'failure' ? 'fail' : 'pass' }]
          : {};
  queueMicrotask(() => {
    callback(null, JSON.stringify(output), '');
    child.emit('close', 0);
  });
  return child;
};
syncBuiltinESMExports();
after(() => {
  cp.execFile = originalExecFile;
  syncBuiltinESMExports();
});

const { githubScheduleFactories } = await import('../dist/domains/plugin/github-schedule-factories.js');
const { fetchPrCiStatuses } = await import('../dist/infrastructure/email/ci-status-batch-fetcher.js');
const factory = githubScheduleFactories.find((item) => item.factoryId === 'github.cicd-check');
const log = { info() {}, warn() {}, error() {} };
function specFor(getGitHubToken, { productionBatch = false } = {}) {
  const routed = [];
  const spec = factory.createTaskSpec('fixture-cicd', {
    taskStore: {
      listByKind: async () => [{ id: 'fixture', kind: 'pr_tracking', subjectKey: 'pr:owner/repo#7', status: 'todo' }],
    },
    cicdRouter: {
      route: async (poll) => {
        routed.push(poll);
        return { kind: 'skipped', reason: 'state-only' };
      },
    },
    log,
    getGitHubToken,
    // Reproduce index's earlier configured-batch closure while exercising factory forwarding.
    ...(!productionBatch
      ? { fetchPrStatuses: (targets, signal) => fetchPrCiStatuses(targets, log, { ghToken: getGitHubToken(), signal }) }
      : {}),
  });
  return { spec, routed };
}

for (const scenario of ['failure', 'pagination'])
  test(`${scenario}: factory forwards configured credential to every query`, async () => {
    mode = scenario;
    calls = [];
    onDetail = undefined;
    const token = `owned-${scenario}-credential`;
    const { spec, routed } = specFor(() => token);
    const gateController = new AbortController();
    const gate = await spec.admission.gate({ signal: gateController.signal });
    assert.equal(calls.length, 1, 'admission still performs one batch read');
    assert.equal(calls[0].token, token, 'configured batch control');
    const itemController = new AbortController();
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, { signal: itemController.signal });
    assert(calls.length > 1);
    assert(
      calls.every((call) => call.token === token),
      'detail/exact queries retain configured credential',
    );
    assert(calls.every((call) => call.ambientToken === undefined));
    assert.equal(routed[0].headSha, 'exact-head');
    assert.equal(routed[0].aggregateBucket, scenario === 'failure' ? 'fail' : 'pass');
  });

test('production default batch and PR-local diagnostics use the same live credential resolver', async () => {
  mode = 'failure';
  calls = [];
  onDetail = undefined;
  let token = 'owned-before-rotation';
  const { spec } = specFor(() => token, { productionBatch: true });
  const gate = await spec.admission.gate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, token);
  token = 'owned-after-rotation';
  await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
  assert(
    calls.slice(1).every((call) => call.token === token),
    'resolve current configured token, do not freeze it in factory',
  );
});

test('configured detail cancellation stays PR-local and does not cancel the admitted batch', async () => {
  mode = 'failure';
  calls = [];
  const token = 'owned-cancel-credential';
  const { spec, routed } = specFor(() => token);
  const gateController = new AbortController();
  const gate = await spec.admission.gate({ signal: gateController.signal });
  const itemController = new AbortController();
  onDetail = () => itemController.abort(new Error('owned detail cancelled'));
  try {
    await assert.rejects(
      spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, { signal: itemController.signal }),
      /owned detail cancelled/,
    );
    assert.equal(gateController.signal.aborted, false);
    assert.equal(calls.length, 2, 'no enrichment requests start after cancellation');
    assert.equal(calls[1].signal.aborted, true);
    assert.equal(calls[1].token, token);
    assert.equal(routed.length, 0, 'cancelled evidence is not routed as complete');
  } finally {
    onDetail = undefined;
  }
});

test('no configured token keeps CLI auth-store semantics throughout batch and detail queries', async () => {
  mode = 'failure';
  calls = [];
  onDetail = undefined;
  const { spec } = specFor(() => undefined, { productionBatch: true });
  const gate = await spec.admission.gate();
  await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
  assert(calls.length > 1);
  assert(calls.every((call) => call.token === undefined && call.ambientToken === undefined));
});
