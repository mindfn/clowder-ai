import { parsePullRequestFullRef } from '@cat-cafe/shared';
import type { PrTitleReader } from '../../domains/cats/services/agents/routing/thread-artifact-pr-titles.js';
import { executeGitHubRequest, gitHubCredentialKey } from './request-budget.js';

/** Read presentation metadata through the existing credential/request owner; never mutate tracking Tasks. */
export function createPrTitleReader(options: {
  getGitHubToken: () => string | undefined;
  execute?: typeof executeGitHubRequest;
  now?: () => number;
}): PrTitleReader {
  const cache = new Map<string, { title: string; expiresAt: number }>();
  const now = options.now ?? Date.now;
  return async (ref, signal) => {
    const target = parsePullRequestFullRef(ref);
    if (!target) return null;
    const token = options.getGitHubToken();
    const key = `${await gitHubCredentialKey(token)}:${ref}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.title;
    const { stdout } = await (options.execute ?? executeGitHubRequest)(
      [
        'api',
        `repos/${target.repoFullName}/pulls/${target.prNumber}`,
        '--jq',
        '{number,title,repository:.base.repo.full_name}',
      ],
      { ghToken: token, signal, timeoutMs: 2_000 },
    );
    const data = JSON.parse(stdout) as { number?: unknown; title?: unknown; repository?: unknown };
    if (
      data.number !== target.prNumber ||
      typeof data.repository !== 'string' ||
      data.repository.toLowerCase() !== target.repoFullName.toLowerCase() ||
      typeof data.title !== 'string' ||
      !data.title.trim()
    )
      return null;
    const title = data.title.trim();
    cache.delete(key);
    cache.set(key, { title, expiresAt: now() + 60_000 });
    const oldestKey = cache.keys().next().value;
    if (cache.size > 256 && oldestKey !== undefined) cache.delete(oldestKey);
    return title;
  };
}
