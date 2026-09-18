import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const runtimeJobs = ['public-test-prepare', 'public-test-shards', 'public-test-summary'];
const versions = runtimeJobs.map((jobName) => {
  const setupNode = workflow.jobs[jobName].steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.ok(setupNode, `${jobName} must configure Node`);
  return String(setupNode.with['node-version']);
});

for (const [index, version] of versions.entries()) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${runtimeJobs[index]} must pin an exact Node patch version`);
}
assert.equal(new Set(versions).size, 1, 'plan producers and consumers must use the same Node runtime');

const shardStep = workflow.jobs['public-test-shards'].steps.find((step) => step.name === 'Run public-test lane');
assert.ok(shardStep, 'the public-test shard runner step must exist');
const summaryStep = workflow.jobs['public-test-summary'].steps.find(
  (step) => step.name === 'Prove complete public-test coverage and summarize timing',
);
assert.ok(summaryStep, 'the public-test summary step must exist');
assert.deepEqual(
  workflow.jobs['public-test-shards'].strategy.matrix.lane,
  [
    'serial-shared',
    'serial-local-1',
    'serial-local-2',
    'serial-local-3',
    'serial-local-4',
    'serial-local-5',
    'pure-1',
    'pure-2',
    'pure-3',
    'pure-4',
  ],
  'public-test CI must retain one shared serial lane, five runner-local serial shards, and four pure shards',
);
assert.deepEqual(
  workflow.jobs['public-test-shards'].permissions,
  { contents: 'read' },
  'public-test shard jobs must not receive repository write permission',
);
const checkoutStep = workflow.jobs['public-test-shards'].steps.find((step) => step.uses === 'actions/checkout@v4');
assert.equal(
  checkoutStep?.with?.['persist-credentials'],
  false,
  'public-test shard jobs must not persist repository credentials',
);
assert.equal(
  shardStep.env?.DEFAULT_OWNER_USER_ID,
  'default-user',
  'public tests must use a deterministic local owner identity',
);
assert.deepEqual(
  Object.keys(shardStep.env ?? {}).sort(),
  ['DEFAULT_OWNER_USER_ID', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME'],
  'public-test shard execution must not receive external service credentials',
);
assert.match(
  summaryStep.run,
  /--max-critical-path-ms 600000(?:\s|$)/,
  'public-test evidence must fail when the measured critical path exceeds 10 minutes',
);

process.stdout.write(
  `public-test CI contract OK (Node ${versions[0]}, owner ${shardStep.env.DEFAULT_OWNER_USER_ID})\n`,
);
