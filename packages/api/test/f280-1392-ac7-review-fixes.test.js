/**
 * #1392 AC-7 — sol re-review fixes (exact HEAD after 228b40954).
 *
 *  P1-C: production audience reader paginates /reviews (no page-2 drop).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createGitHubTrackingAudienceReader,
  parsePaginatedReviewLogins,
} from '../dist/domains/github-signals/github-tracking-audience-reader.js';

describe('#1392 AC-7 P1-C — audience reader pagination (production reader, not pre-injected arrays)', () => {
  test('parsePaginatedReviewLogins merges every page of {login} output', () => {
    const lines = Array.from({ length: 45 }, (_, i) => JSON.stringify({ login: `rev${i}` }));
    const parsed = parsePaginatedReviewLogins(lines.join('\n'));
    assert.equal(parsed.length, 45);
    assert.equal(parsed[44], 'rev44'); // a page-2 reviewer survives
  });

  test('parsePaginatedReviewLogins skips blanks and null logins', () => {
    const out = [
      JSON.stringify({ login: 'a' }),
      '',
      JSON.stringify({ login: null }),
      JSON.stringify({ login: 'b' }),
    ].join('\n');
    assert.deepEqual(parsePaginatedReviewLogins(out), ['a', 'b']);
  });

  test('production PR reader fetches /reviews with --paginate and captures all pages (no 30-cap)', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push([...args]);
      const joined = args.join(' ');
      if (joined.includes('/reviews')) {
        // 40 reviewers — a single default page would silently cap this at 30.
        return Array.from({ length: 40 }, (_, i) => JSON.stringify({ login: `r${i}` })).join('\n');
      }
      if (joined.includes('/requested_reviewers')) return JSON.stringify({ users: ['req1'], teams: ['team-a'] });
      return JSON.stringify({ author: 'author1' }); // /pulls/{n}
    };
    const reader = createGitHubTrackingAudienceReader(gh);
    const audience = await reader.pr('owner/repo', 7);
    assert.equal(audience.priorReviewAuthors.length, 40, 'all 40 review authors captured');
    const reviewsCall = calls.find((a) => a.join(' ').includes('/reviews'));
    assert.ok(reviewsCall?.includes('--paginate'), '/reviews MUST be fetched with --paginate');
    assert.equal(audience.author, 'author1');
    assert.deepEqual(audience.requestedUsers, ['req1']);
    assert.deepEqual(audience.requestedTeams, ['team-a']);
  });

  test('production issue reader returns author + assignees', async () => {
    const reader = createGitHubTrackingAudienceReader(async () =>
      JSON.stringify({ author: 'iauthor', assignees: ['asg1', 'asg2'] }),
    );
    assert.deepEqual(await reader.issue('owner/repo', 42), { author: 'iauthor', assignees: ['asg1', 'asg2'] });
  });
});
