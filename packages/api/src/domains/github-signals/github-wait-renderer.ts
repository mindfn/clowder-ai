import type { WaitOutcomeV1 } from '@cat-cafe/shared';

export function renderGitHubWaitOutcome(outcome: WaitOutcomeV1): string {
  const isIssue = outcome.subjectRef.startsWith('issue:');
  const subject = outcome.subjectRef.slice(isIssue ? 'issue:'.length : 'pr:'.length);
  const kind = isIssue ? 'Issue' : 'PR';

  // #1392 AC-2: an expired outcome is a LOUD terminal, not a satisfied match. Say so plainly so
  // the owner knows tracking is over and nothing is armed — never render it as "wait satisfied".
  if (outcome.reason === 'expired') {
    return [
      `⏰ **${kind} tracking expired** — ${subject}`,
      '',
      '- Tracking window elapsed; no longer armed.',
      '',
      'Reason: `expired`',
    ].join('\n');
  }

  const lines = [`🔔 **${kind} wait satisfied** — ${subject}`, ''];

  if (outcome.reason === 'subject_terminal') {
    lines.push(`- ${isIssue ? 'Issue' : 'PR'} state: ${outcome.terminalSubjectState ?? 'closed'}`);
  } else {
    for (const match of outcome.matched ?? []) {
      lines.push(`- ${match.delta}`);
    }
  }

  lines.push('', `Matched reason: \`${outcome.reason}\``);
  if (outcome.nextStep) lines.push(`Next: ${outcome.nextStep}`);
  // #1392 AC-1: truthful rearm signal — tell the owner whether tracking continues after this wake.
  // Only a matched wake can auto-renew; subject_terminal is terminal (nothing to re-arm).
  if (outcome.reason === 'matched') {
    lines.push(outcome.autoRenewed ? '_Tracking re-armed for the next event._' : '_Tracking closed (single-fire)._');
  }
  return lines.join('\n');
}
