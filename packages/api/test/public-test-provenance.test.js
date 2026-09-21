import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { currentPublicTestProvenance } from '../scripts/public-test-provenance.mjs';

const temporaryRepositories = [];

function git(repository, ...args) {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), 'public-test-provenance-'));
  temporaryRepositories.push(repository);
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.email', 'ci@example.com');
  git(repository, 'config', 'user.name', 'CI');
  writeFileSync(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
  git(repository, 'add', 'pnpm-lock.yaml', 'tracked.txt');
  git(repository, 'commit', '--quiet', '-m', 'fixture');
  return repository;
}

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('F308 public-test provenance', () => {
  it('attests the committed tree for a clean workspace', () => {
    const repository = createRepository();

    const provenance = currentPublicTestProvenance(repository);

    assert.equal(provenance.workspaceTree, git(repository, 'rev-parse', 'HEAD^{tree}'));
  });

  for (const [name, makeDirty] of [
    ['unstaged tracked changes', (repository) => writeFileSync(join(repository, 'tracked.txt'), 'modified\n')],
    [
      'staged changes',
      (repository) => {
        writeFileSync(join(repository, 'tracked.txt'), 'staged\n');
        git(repository, 'add', 'tracked.txt');
      },
    ],
    ['untracked files', (repository) => writeFileSync(join(repository, 'untracked.txt'), 'untracked\n')],
  ]) {
    it(`fails closed for ${name}`, () => {
      const repository = createRepository();
      makeDirty(repository);

      assert.throws(() => currentPublicTestProvenance(repository), /public-test provenance requires a clean workspace/);
    });
  }
});
