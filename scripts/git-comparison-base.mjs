import { execFileSync } from 'node:child_process';

export function resolveContributionBase(repoRoot, runGit = execFileSync) {
  try {
    runGit('git', ['merge-base', '--is-ancestor', 'origin/develop_base', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return 'origin/develop_base';
  } catch {
    // Upstream-facing branches are cut from the public mirror and therefore do
    // not contain the fork-only develop_base history. Keep the public baseline
    // for those branches and for repositories without a develop_base ref.
    return 'origin/main';
  }
}
