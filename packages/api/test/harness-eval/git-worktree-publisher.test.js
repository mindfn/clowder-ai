import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

function createRepoWithOrigin() {
  const repoRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-repo-'));
  const remoteRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-remote-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return { repoRoot, remoteRoot };
}

function branchExists(repoRoot, branchName) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  syncBuiltinESMExports();
});

describe('parseOwnerRepoFromGitRemoteUrl', () => {
  it('parses every git/gh remote URL form to owner/repo (砚砚 2026-06-17 P1)', async () => {
    const { parseOwnerRepoFromGitRemoteUrl } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js'
    );
    const cases = [
      // scp-like SSH (what `git remote get-url origin` returns for github SSH)
      ['git@github.com:mindfn/clowder-ai.git', 'mindfn/clowder-ai'],
      ['git@github.com:mindfn/clowder-ai', 'mindfn/clowder-ai'],
      // ssh:// form
      ['ssh://git@github.com/zts212653/clowder-ai.git', 'zts212653/clowder-ai'],
      // https forms (with and without .git, with and without creds)
      ['https://github.com/mindfn/clowder-ai.git', 'mindfn/clowder-ai'],
      ['https://github.com/mindfn/clowder-ai', 'mindfn/clowder-ai'],
      ['https://x-access-token:ghp_abc@github.com/mindfn/clowder-ai.git', 'mindfn/clowder-ai'],
      // trailing slash tolerance
      ['https://github.com/mindfn/clowder-ai/', 'mindfn/clowder-ai'],
      // whitespace (stdout trim defense-in-depth)
      ['  git@github.com:mindfn/clowder-ai.git\n', 'mindfn/clowder-ai'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(parseOwnerRepoFromGitRemoteUrl(input), expected, `failed for input: ${JSON.stringify(input)}`);
    }
  });

  it('throws on URLs that have no owner/repo (defensive)', async () => {
    const { parseOwnerRepoFromGitRemoteUrl } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js'
    );
    assert.throws(() => parseOwnerRepoFromGitRemoteUrl(''), /empty git remote url/);
    assert.throws(() => parseOwnerRepoFromGitRemoteUrl('git@github.com:justrepo'), /cannot derive owner\/repo/);
    assert.throws(() => parseOwnerRepoFromGitRemoteUrl('https://github.com/onlyowner'), /cannot derive owner\/repo/);
  });
});

describe('createGitWorktreePublisher — --no-verify regression', () => {
  it('commit succeeds when pre-commit hook would reject (no node_modules)', async (t) => {
    // Regression: the isolated worktree has no node_modules. Without --no-verify,
    // `git commit` fires the pre-commit hook (Biome Guard), which fails with
    // ENOENT on `pnpm exec biome check`. This test installs a pre-commit hook
    // that always exits 1, proving the publisher bypasses it.
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    t.after(() => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
    });

    // Install a pre-commit hook that always fails
    const hooksDir = join(repoRoot, '.githooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'pre-commit'),
      '#!/bin/bash\necho "HOOK: would fail without --no-verify" >&2\nexit 1\n',
      {
        mode: 0o755,
      },
    );
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'ignore' });

    const branchName = 'verdict/auto/eval-a2a/no-verify-regression';

    const { createGitWorktreePublisher } = await import(
      `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-noverify`
    );
    const publisher = createGitWorktreePublisher({ repoRoot });

    // assert.rejects: proves the publisher REJECTS (gh pr create fails on
    // bare remote), and the rejection is NOT from the pre-commit hook.
    // Unlike try/catch + assert.fail, this cannot accidentally swallow a
    // false-positive success path.
    await assert.rejects(
      publisher.publishOnIsolatedWorktree({
        branchName,
        sourceBase: 'origin/main',
        stage: async (wtPath) => {
          const artifactPath = join(wtPath, 'docs', 'harness-feedback', 'verdicts', 'test-verdict.yaml');
          fs.mkdirSync(join(wtPath, 'docs', 'harness-feedback', 'verdicts'), { recursive: true });
          writeFileSync(artifactPath, 'verdict: keep_observe\n');
          return {
            paths: [artifactPath],
            commitMessage: 'verdict: test --no-verify regression',
            prTitle: 'test: --no-verify regression',
            prBody: 'Automated test',
            labels: [],
          };
        },
      }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          !msg.includes('would fail without --no-verify'),
          `pre-commit hook must be bypassed by --no-verify, but fired: ${msg}`,
        );
        return true;
      },
    );

    // Positive proof: branch exists on the bare remote → commit + push
    // both succeeded before gh pr create failed. The publisher's finally
    // block deletes the LOCAL branch, but the remote ref survives (gh pr
    // list fails on a bare remote → safeToDelete stays false).
    let remoteRefExists = false;
    try {
      execFileSync('git', ['-C', remoteRoot, 'rev-parse', '--verify', `refs/heads/${branchName}`], {
        stdio: 'ignore',
      });
      remoteRefExists = true;
    } catch {
      // branch not found
    }
    assert.ok(remoteRefExists, 'branch must exist on bare remote — proves commit + push succeeded before gh failed');
  });
});

describe('createGitWorktreePublisher', () => {
  it('cleans up a partially-created local branch when worktree add fails before stage', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger partial failure\n');
    const branchName = 'verdict/auto/eval-task-outcome/partial-fail-cleanup';

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}`
      );
      const publisher = createGitWorktreePublisher({ repoRoot });

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        false,
        'partial worktree-add failure must not leak a local branch',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('does not delete a branch that already existed before the publish attempt', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const branchName = 'verdict/auto/eval-task-outcome/pre-existing-branch';
    execFileSync('git', ['branch', branchName, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });

    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger failure without ownership\n');

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-keep`
      );
      const publisher = createGitWorktreePublisher({ repoRoot });

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        true,
        'cleanup must not delete a branch that predates this publish attempt',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
