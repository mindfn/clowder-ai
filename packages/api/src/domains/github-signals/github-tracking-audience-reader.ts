import type { GitHubIssueAudience, GitHubPrAudience } from './github-tracking-preview.js';

/**
 * #1392 AC-7 — production GitHub audience reader for the tracking-preview helper.
 *
 * The `gh` command runner is INJECTED so the reader (endpoint selection, the
 * `--paginate` contract, and page merging) is unit-testable without shelling out.
 * index.ts wires the real `gh` via execFile.
 */
export type GhExec = (args: readonly string[], timeoutMs: number) => Promise<string>;

/**
 * Parse newline-delimited `{login}` JSON objects — the output of
 * `gh api --paginate … --jq '.[] | {login: .user.login}'` — across EVERY page.
 * With `--paginate`, gh applies the jq per page and concatenates, so a PR with
 * more than one page of reviews still yields all review authors here (the P1
 * fail-open bug was the missing `--paginate`, which capped the reader at 30).
 */
export function parsePaginatedReviewLogins(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const logins: string[] = [];
  for (const line of trimmed.split('\n')) {
    const entry = line.trim();
    if (!entry) continue;
    const parsed = JSON.parse(entry) as { login?: unknown };
    if (typeof parsed.login === 'string' && parsed.login.length > 0) logins.push(parsed.login);
  }
  return logins;
}

export interface GitHubTrackingAudienceReader {
  pr: (repoFullName: string, prNumber: number) => Promise<GitHubPrAudience>;
  issue: (repoFullName: string, issueNumber: number) => Promise<GitHubIssueAudience>;
}

export function createGitHubTrackingAudienceReader(gh: GhExec): GitHubTrackingAudienceReader {
  return {
    pr: async (repoFullName, prNumber) => {
      const [prOut, reviewersOut, reviewsOut] = await Promise.all([
        // Single objects (all reviewers/teams returned in one response) — no pagination.
        gh(['api', `repos/${repoFullName}/pulls/${prNumber}`, '--jq', '{author:.user.login}'], 15_000),
        gh(
          [
            'api',
            `repos/${repoFullName}/pulls/${prNumber}/requested_reviewers`,
            '--jq',
            '{users:[.users[].login],teams:[.teams[].slug]}',
          ],
          15_000,
        ),
        // #1392 AC-7 P1 (sol): /reviews is a paginated LIST (default 30/page). Without
        // --paginate, page-2 reviewers are silently dropped and an incomplete audience
        // could still return register_ready (fail-open). --paginate + per-line {login}
        // merges every page; a longer timeout accommodates multi-page fetches.
        gh(
          [
            'api',
            '--paginate',
            `repos/${repoFullName}/pulls/${prNumber}/reviews`,
            '--jq',
            '.[] | {login: .user.login}',
          ],
          30_000,
        ),
      ]);
      const author = (JSON.parse(prOut.trim() || '{}') as { author?: string }).author ?? '';
      const reviewers = JSON.parse(reviewersOut.trim() || '{}') as { users?: string[]; teams?: string[] };
      return {
        author,
        requestedUsers: reviewers.users ?? [],
        requestedTeams: reviewers.teams ?? [],
        priorReviewAuthors: parsePaginatedReviewLogins(reviewsOut),
      };
    },
    issue: async (repoFullName, issueNumber) => {
      const out = await gh(
        [
          'api',
          `repos/${repoFullName}/issues/${issueNumber}`,
          '--jq',
          '{author:.user.login,assignees:[.assignees[].login]}',
        ],
        15_000,
      );
      const parsed = JSON.parse(out.trim() || '{}') as { author?: string; assignees?: string[] };
      return { author: parsed.author ?? '', assignees: parsed.assignees ?? [] };
    },
  };
}
