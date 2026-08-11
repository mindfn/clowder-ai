import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createGitVerdictPrRefresher } from '../../dist/infrastructure/harness-eval/publish-verdict/git-verdict-pr-refresher.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

const CENSUS_PATH = 'docs/harness-feedback/registry/measurement-bundles.yaml';
const PR_MARKER = 'Verdict published via cat_cafe_publish_verdict MCP tool.';

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function publicPacket(id, verdict = 'keep_observe') {
  return buildPacket({
    id,
    verdict,
    evidencePacket: {
      snapshotRefs: ['snapshot:test'],
      attributionRefs: ['attribution:test'],
      metricRefs: ['metric:turn_custody.projections_total'],
      sampleTraceRefs: ['trace:test'],
    },
    dailyTrend: {
      window: '24h',
      current: { 'turn_custody.projections_total': 0 },
      baseline: { 'turn_custody.projections_total': 0 },
      threshold: { 'turn_custody.projections_total': 1 },
      direction: 'flat',
    },
  });
}

async function publishAgainstCensusFreeWorktree(packet, generator) {
  const liveRoot = setupHarnessFeedback();
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'public-verdict-iso-'));
  let stageResult;
  try {
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: liveRoot,
        generator,
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            stageResult = await opts.stage(isolatedRoot);
            return { commitSha: 'public123', prUrl: 'https://example.test/public-verdict-pr' };
          },
        },
      },
      {
        packet,
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snapshot.yaml', attributionName: 'attribution.yaml' },
      },
    );
    return { result, stageResult };
  } finally {
    rmSync(liveRoot, { recursive: true, force: true });
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

describe('public export verdict closure without the home-only F267 census', () => {
  it('publishes keep_observe artifacts without inventing a public census', async () => {
    const packet = publicPacket('public-no-census-observe');
    const { result, stageResult } = await publishAgainstCensusFreeWorktree(packet, async (input, _refs, deps) => {
      const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${input.id}.md`);
      const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', input.id);
      mkdirSync(dirname(verdictPath), { recursive: true });
      writeFileSync(verdictPath, `---\ndomain_id: ${input.domainId}\n---\n`);
      mkdirSync(bundleDir, { recursive: true });
      return { verdictPath, bundleDir };
    });

    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal(stageResult.paths.length, 2);
    assert.equal(
      stageResult.paths.some((path) => path.endsWith(CENSUS_PATH)),
      false,
    );
  });

  it('keeps actionable verdicts fail-closed when the census is unavailable', async () => {
    let generatorCalled = false;
    const { result } = await publishAgainstCensusFreeWorktree(publicPacket('public-no-census-fix', 'fix'), async () => {
      generatorCalled = true;
      throw new Error('generator must not run');
    });

    assert.ok('error' in result);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'measurement_validity_gate');
    assert.match(result.detail, /census.*unavailable|unavailable.*census/i);
    assert.equal(generatorCalled, false);
  });

  it('refreshes a stale public verdict PR without requiring or creating a census', async (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'public-verdict-refresh-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'public-verdict-refresh-remote-'));
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    });

    const verdictId = 'public-no-census-refresh';
    const branchName = `verdict/auto/eval-a2a/${verdictId}`;
    const verdictPath = `docs/harness-feedback/verdicts/${verdictId}.md`;
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    write(repo, 'README.md', '# public checkout\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init public checkout');
    git(remote, 'init', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-u', 'origin', 'main');

    git(repo, 'switch', '-c', branchName);
    write(repo, verdictPath, '# public verdict\n');
    write(repo, `docs/harness-feedback/bundles/${verdictId}/snapshot.json`, '{}\n');
    git(repo, 'add', 'docs/harness-feedback');
    git(repo, 'commit', '-m', 'publish public verdict');
    git(repo, 'push', '-u', 'origin', branchName);
    const branchHead = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'switch', 'main');
    write(repo, 'README.md', '# public checkout\n\nbase moved\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'move public base');
    git(repo, 'push', 'origin', 'main');

    const refresh = createGitVerdictPrRefresher({
      repoRoot: repo,
      resolveOpenPr: async () => [
        {
          url: 'https://example.test/public-verdict-pr',
          headRefOid: branchHead,
          headRefName: branchName,
          baseRefName: 'main',
          body: PR_MARKER,
        },
      ],
    });
    const result = await refresh({
      branchName,
      verdictId,
      expectedHeadSha: branchHead,
      generatedAt: '2026-08-07T03:00:00.000Z',
      refreshDerivedCensus() {
        throw new Error('public refresh must not synthesize a private census');
      },
    });

    const refreshedHead = git(remote, 'rev-parse', `refs/heads/${branchName}`);
    assert.equal(result.outcome, 'updated');
    assert.equal(result.commitSha, refreshedHead);
    assert.equal(git(repo, 'merge-base', '--is-ancestor', 'origin/main', refreshedHead), '');
    assert.equal(git(remote, 'show', `${refreshedHead}:${verdictPath}`), '# public verdict');
    assert.throws(() =>
      execFileSync('git', ['cat-file', '-e', `${refreshedHead}:${CENSUS_PATH}`], {
        cwd: remote,
        stdio: 'ignore',
      }),
    );
  });
});
