import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  callbackTools,
  previewGitHubTrackingInputSchema,
  registerIssueTrackingInputSchema,
  registerPrTrackingInputSchema,
} from '../src/tools/callback-tools.js';

// #1392 AC-7 P2-B (sol): the MCP schema must REJECT case-insensitive duplicate logins
// up front, exactly like the API route — otherwise MCP says OK while the server says no.
describe('#1392 AC-7 P2-B — MCP authorLogins case-insensitive uniqueness mirrors the API', () => {
  it('register_pr_tracking rejects ["Maintainer","maintainer"] in a conversation-comment predicate', () => {
    const schema = z.object(registerPrTrackingInputSchema);
    const rejected = schema.safeParse({
      repoFullName: 'owner/repo',
      prNumber: 7,
      when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['Maintainer', 'maintainer'] }],
      nextStep: 'do',
    });
    assert.equal(rejected.success, false);
    const accepted = schema.safeParse({
      repoFullName: 'owner/repo',
      prNumber: 7,
      when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['alice', 'bob'] }],
      nextStep: 'do',
    });
    assert.equal(accepted.success, true);
  });

  it('register_issue_tracking rejects case-insensitive duplicate issue authorLogins', () => {
    const schema = z.object(registerIssueTrackingInputSchema);
    const rejected = schema.safeParse({
      repoFullName: 'owner/repo',
      issueNumber: 42,
      when: [{ kind: 'issue_comment_added', authorLogins: ['Bot', 'bot'] }],
      nextStep: 'do',
    });
    assert.equal(rejected.success, false);
  });

  it('preview additionalLogins and overrideLogins reject case-insensitive duplicates', () => {
    const schema = z.object(previewGitHubTrackingInputSchema);
    const base = {
      intent: 'wait_for_reviewer_response' as const,
      subject: { kind: 'pr' as const, repoFullName: 'owner/repo', number: 7 },
    };
    assert.equal(schema.safeParse({ ...base, additionalLogins: ['A', 'a'] }).success, false);
    assert.equal(schema.safeParse({ ...base, overrideLogins: ['X', 'x'] }).success, false);
    assert.equal(schema.safeParse({ ...base, additionalLogins: ['A', 'b'] }).success, true);
  });
});

// #1392 AC-7 P2-C (sol): a signed-off new surface must be canonical, not a migration candidate.
describe('#1392 AC-7 P2-C — preview tool is canonical', () => {
  it('cat_cafe_preview_github_tracking has activeState "canonical"', () => {
    const preview = callbackTools.find((tool) => tool.name === 'cat_cafe_preview_github_tracking');
    assert.ok(preview, 'preview tool must be registered');
    assert.equal(preview.policy.activeState, 'canonical');
  });
});
