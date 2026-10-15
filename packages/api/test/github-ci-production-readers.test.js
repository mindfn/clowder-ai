import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { registerGitHubScheduleFactories } from '../dist/domains/plugin/github-schedule-factories.js';
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';
import { createCiCollectionReaders } from '../dist/infrastructure/email/ci-status-batch-fetcher.js';

test('production-shaped plugin wiring defers details, uses one credential, and routes the enriched failure', async () => {
  const taskStore = new TaskStore();
  await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread-7',
    title: 'CI',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
  });
  const log = { info() {}, warn() {}, error() {} };
  const commands = [];
  const readers = createCiCollectionReaders(log, () => 'production-reader-fixture', {
    async execFileAsync(_file, args, options) {
      commands.push(args);
      assert.equal(options.timeout, 5_000);
      assert.equal(options.env.GITHUB_TOKEN, 'production-reader-fixture');
      if (args[1] === 'graphql')
        return {
          stdout: JSON.stringify({
            data: {
              r0: {
                p0: {
                  headRefOid: 'head-7',
                  state: 'OPEN',
                  mergedAt: null,
                  mergedBy: null,
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' },
                              ],
                              pageInfo: { hasNextPage: false },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      if (args[0] === 'pr' && args[1] === 'view')
        return {
          stdout: JSON.stringify({
            headRefOid: 'head-7',
            state: 'OPEN',
            mergedAt: null,
            statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
          }),
        };
      if (args[0] === 'pr') return { stdout: JSON.stringify([{ name: 'gate', bucket: 'fail' }]) };
      if (args[1].includes('/check-runs?')) return { stdout: JSON.stringify({ check_runs: [] }) };
      if (args[1].includes('/actions/runs?')) return { stdout: JSON.stringify({ workflow_runs: [] }) };
      throw new Error(`unexpected request: ${args[0]} ${args[1]}`);
    },
  });
  const registry = new ScheduleFactoryRegistry();
  registerGitHubScheduleFactories(registry);
  const routed = [];
  const spec = registry.get('github.cicd-check').createTaskSpec('schedule:github:cicd-check', {
    taskStore,
    log,
    ...readers,
    cicdRouter: {
      route: async (poll) => {
        routed.push(poll);
        return { kind: 'skipped', reason: 'state-only' };
      },
    },
  });
  const gate = await spec.admission.gate();
  assert.equal(commands.length, 1, 'admission performs only the bounded facts read');
  await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
    signal: new AbortController().signal,
  });
  assert.equal(routed.length, 1);
  assert.notEqual(routed[0].failureDetailsPending, true);
  assert.equal(routed[0].checks[0].name, 'gate');
  assert.equal(routed[0].aggregateBucket, 'fail');
});
