import type { GitHubIssueWaitPredicate, GitHubPrWaitPredicate } from '@cat-cafe/shared';

/**
 * #1392 AC-7 — Transparent tracking-preview helper (pure expansion core).
 *
 * The preview resolves a closed, typed maintainer/contributor journey into the
 * exact `when[]` + `then` + optional `expiresAt` that the EXISTING
 * `register_pr_tracking` / `register_issue_tracking` tools accept, and shows it
 * BEFORE anything is registered. It never freezes a baseline, never writes the
 * TaskStore, and never persists a role/preset/subscription — it is transparent
 * expansion only (`baselineFrozen: false`). The register step remains the sole
 * durable install.
 *
 * Fail-closed contract (sol, #1392): an audience is either resolved to an exact
 * positive login allowlist (1–20, case-insensitively unique) or the preview
 * refuses to emit a register-ready payload. It NEVER silently truncates, guesses
 * team membership, or degrades to "anyone".
 */

/** Closed set of typed journeys. No free text. */
export type GitHubTrackingPreviewIntent = 'wait_for_author_update' | 'wait_for_reviewer_response' | 'reply_and_wait';

export interface GitHubTrackingPreviewSubject {
  readonly kind: 'pr' | 'issue';
  readonly repoFullName: string;
  readonly number: number;
}

export interface GitHubTrackingPreviewInput {
  readonly intent: GitHubTrackingPreviewIntent;
  readonly subject: GitHubTrackingPreviewSubject;
  /**
   * Caller-supplied EXACT logins.
   * - `wait_for_reviewer_response`: unioned with resolved reviewers, and their
   *   presence is the caller's explicit acknowledgement of any unresolved team.
   * - `reply_and_wait`: the REQUIRED exact audience (there is no auto-resolution).
   * - `wait_for_author_update`: not part of the semantics (the author is resolved).
   */
  readonly additionalLogins?: readonly string[];
  /**
   * `wait_for_reviewer_response` only: EXACT replacement of the auto-resolved
   * reviewer audience. When non-empty, the audience is exactly these logins
   * (auto-resolution, additionalLogins, and requested teams are all bypassed).
   * This is the executable narrow path when auto-resolution overflows >20 —
   * additionalLogins can only UNION (never narrow), so it cannot fix an overflow.
   */
  readonly overrideLogins?: readonly string[];
  /** author_update / reviewer_response only. reply_and_wait is FIXED single-fire. Default true. */
  readonly autoRenew?: boolean;
  /**
   * Visible continuation suggestion; overrides the default. Named `nextStep` to
   * match the register tool's field (expanded.args.nextStep) the preview feeds
   * into. Display-only — never parsed as wake policy.
   */
  readonly nextStep?: string;
  /** Passed through as-is; shown but not defaulted. */
  readonly expiresAt?: number;
  /**
   * reply_and_wait choreography: the caller has already posted their external
   * reply. When expansion cannot arm tracking, the result is the explicit
   * `reply_succeeded_tracking_not_armed` status instead of a generic failure so
   * the caller never re-posts their comment.
   */
  readonly replyAlreadySent?: boolean;
}

/** Pre-fetched GitHub reads for a PR subject (route resolves these; the core stays pure). */
export interface GitHubPrAudience {
  readonly author: string;
  readonly requestedUsers: readonly string[];
  readonly requestedTeams: readonly string[];
  readonly priorReviewAuthors: readonly string[];
}

/** Pre-fetched GitHub reads for an issue subject. */
export interface GitHubIssueAudience {
  readonly author: string;
  readonly assignees: readonly string[];
}

export type GitHubTrackingAudience = GitHubPrAudience | GitHubIssueAudience;

export type AudienceSourceKind =
  | 'pr_author'
  | 'requested_reviewers'
  | 'prior_review_authors'
  | 'issue_author'
  | 'issue_assignees'
  | 'caller_input'
  | 'exact_override';

export interface ResolvedAudienceSource {
  readonly source: AudienceSourceKind;
  readonly logins: readonly string[];
}

export interface ResolvedAudience {
  /** Final, deduped (case-insensitive), first-seen-ordered exact allowlist. */
  readonly authorLogins: readonly string[];
  /** Per-source provenance so the caller sees exactly where each login came from. */
  readonly sources: readonly ResolvedAudienceSource[];
  readonly unresolved: {
    readonly teams?: readonly string[];
    readonly reason?: string;
  };
}

export type RegisterPrTrackingArgs = {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly when: readonly GitHubPrWaitPredicate[];
  readonly nextStep: string;
  readonly autoRenew: boolean;
  readonly expiresAt?: number;
};

export type RegisterIssueTrackingArgs = {
  readonly repoFullName: string;
  readonly issueNumber: number;
  readonly when: readonly GitHubIssueWaitPredicate[];
  readonly nextStep: string;
  readonly autoRenew: boolean;
  readonly expiresAt?: number;
};

export interface ExpandedRegistration {
  readonly registerTool: 'register_pr_tracking' | 'register_issue_tracking';
  readonly args: RegisterPrTrackingArgs | RegisterIssueTrackingArgs;
}

export type GitHubTrackingPreviewStatus = 'register_ready' | 'needs_input' | 'reply_succeeded_tracking_not_armed';

export interface GitHubTrackingPreviewResult {
  readonly status: GitHubTrackingPreviewStatus;
  readonly humanSummary: string;
  readonly resolvedAudience: ResolvedAudience;
  readonly expanded?: ExpandedRegistration;
  /** Preview never freezes a baseline — the invariant is stated in the payload. */
  readonly baselineFrozen: false;
}

const MAX_AUDIENCE = 20;

/** Case-insensitive dedupe that preserves first-seen original casing. */
function dedupeLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of logins) {
    const login = raw.trim();
    if (login.length === 0) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

function subjectLabel(subject: GitHubTrackingPreviewSubject): string {
  const kind = subject.kind === 'pr' ? 'PR' : 'issue';
  return `${kind} ${subject.repoFullName}#${subject.number}`;
}

function defaultContinuation(intent: GitHubTrackingPreviewIntent): string {
  switch (intent) {
    case 'wait_for_author_update':
      return "Read the author's update and continue the review.";
    case 'wait_for_reviewer_response':
      return "Read the reviewer's response and address it.";
    case 'reply_and_wait':
      return 'Read their reply and continue the conversation.';
  }
}

function isPrAudience(a: GitHubTrackingAudience | null): a is GitHubPrAudience {
  return a !== null && 'requestedUsers' in a;
}

type CollectedSources = { sources: ResolvedAudienceSource[]; teams: string[] };

function pushIfPresent(sources: ResolvedAudienceSource[], source: AudienceSourceKind, logins: readonly string[]): void {
  if (logins.length > 0) sources.push({ source, logins });
}

/** PR audience per intent. author_update ⇒ author; reviewer_response ⇒ requested ∪ prior ∪ caller. */
function collectPrSources(
  intent: GitHubTrackingPreviewIntent,
  audience: GitHubPrAudience,
  callerLogins: readonly string[],
): CollectedSources {
  const sources: ResolvedAudienceSource[] = [];
  if (intent === 'wait_for_author_update') {
    pushIfPresent(sources, 'pr_author', audience.author ? [audience.author] : []);
    return { sources, teams: [] };
  }
  pushIfPresent(sources, 'requested_reviewers', dedupeLogins(audience.requestedUsers));
  pushIfPresent(sources, 'prior_review_authors', dedupeLogins(audience.priorReviewAuthors));
  pushIfPresent(sources, 'caller_input', callerLogins);
  // Requested teams cannot be expanded to exact members — surfaced, never guessed.
  return { sources, teams: dedupeLogins(audience.requestedTeams) };
}

/** Issue audience per intent. author_update ⇒ author; reviewer_response ⇒ assignees ∪ caller. */
function collectIssueSources(
  intent: GitHubTrackingPreviewIntent,
  audience: GitHubIssueAudience,
  callerLogins: readonly string[],
): CollectedSources {
  const sources: ResolvedAudienceSource[] = [];
  if (intent === 'wait_for_author_update') {
    pushIfPresent(sources, 'issue_author', audience.author ? [audience.author] : []);
    return { sources, teams: [] };
  }
  pushIfPresent(sources, 'issue_assignees', dedupeLogins(audience.assignees));
  pushIfPresent(sources, 'caller_input', callerLogins);
  return { sources, teams: [] };
}

/**
 * Collect the raw per-source logins for an intent, WITHOUT applying the
 * fail-closed gate. `sources` carries provenance; `teams` are the unresolvable
 * requested teams (membership is never guessed).
 */
function collectSources(input: GitHubTrackingPreviewInput, audience: GitHubTrackingAudience | null): CollectedSources {
  const callerLogins = dedupeLogins(input.additionalLogins ?? []);
  if (input.intent === 'reply_and_wait') {
    // No auto-resolution: the caller names the exact audience they replied to.
    return { sources: callerLogins.length > 0 ? [{ source: 'caller_input', logins: callerLogins }] : [], teams: [] };
  }
  // wait_for_reviewer_response exact override: replace the auto-resolved audience
  // entirely (bypass auto-resolution, additionalLogins, and requested teams). This
  // is the only NARROW path — additionalLogins can only union, never shrink an
  // overflowed audience.
  if (input.intent === 'wait_for_reviewer_response') {
    const overrideLogins = dedupeLogins(input.overrideLogins ?? []);
    if (overrideLogins.length > 0) {
      return { sources: [{ source: 'exact_override', logins: overrideLogins }], teams: [] };
    }
  }
  if (input.subject.kind === 'pr' && isPrAudience(audience)) {
    return collectPrSources(input.intent, audience, callerLogins);
  }
  if (input.subject.kind === 'issue' && audience !== null && !isPrAudience(audience)) {
    return collectIssueSources(input.intent, audience, callerLogins);
  }
  return { sources: [], teams: [] };
}

function buildWhenPredicates(
  input: GitHubTrackingPreviewInput,
  authorLogins: readonly string[],
): readonly (GitHubPrWaitPredicate | GitHubIssueWaitPredicate)[] {
  const logins = [...authorLogins];
  if (input.subject.kind === 'pr') {
    if (input.intent === 'wait_for_author_update') {
      // Author "updates" by pushing a new HEAD or by commenting.
      return [{ kind: 'pr_head_changed' }, { kind: 'pr_conversation_comment_added', authorLogins: logins }];
    }
    if (input.intent === 'wait_for_reviewer_response') {
      // A reviewer "responds" via a FORMAL review — approve / request-changes,
      // even with no body → pr_review_decision_changed — OR a conversation comment
      // scoped to the resolved reviewer audience. sol (#1392 AC-7 review, P1):
      // pr_review_decision_changed catches the bodyless decision; NOT
      // pr_review_result_available, which belongs to the exact Codex review-result
      // chain and is not the reviewer-response signal.
      return [{ kind: 'pr_review_decision_changed' }, { kind: 'pr_conversation_comment_added', authorLogins: logins }];
    }
    // reply_and_wait: exact comment predicate ONLY — no structural arm.
    return [{ kind: 'pr_conversation_comment_added', authorLogins: logins }];
  }
  // Issue subjects: the only audience-scoped predicate is issue_comment_added
  // (issues have no review-decision concept).
  return [{ kind: 'issue_comment_added', authorLogins: logins }];
}

function resolveAutoRenew(input: GitHubTrackingPreviewInput): boolean {
  if (input.intent === 'reply_and_wait') return false; // FIXED single-fire.
  return input.autoRenew ?? true;
}

function buildExpanded(
  input: GitHubTrackingPreviewInput,
  when: readonly (GitHubPrWaitPredicate | GitHubIssueWaitPredicate)[],
): ExpandedRegistration {
  const nextStep = input.nextStep ?? defaultContinuation(input.intent);
  const autoRenew = resolveAutoRenew(input);
  const expiresAtPart = input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {};
  if (input.subject.kind === 'pr') {
    return {
      registerTool: 'register_pr_tracking',
      args: {
        repoFullName: input.subject.repoFullName,
        prNumber: input.subject.number,
        when: when as readonly GitHubPrWaitPredicate[],
        nextStep,
        autoRenew,
        ...expiresAtPart,
      },
    };
  }
  return {
    registerTool: 'register_issue_tracking',
    args: {
      repoFullName: input.subject.repoFullName,
      issueNumber: input.subject.number,
      when: when as readonly GitHubIssueWaitPredicate[],
      nextStep,
      autoRenew,
      ...expiresAtPart,
    },
  };
}

/**
 * Pure expansion. Given the typed intent and the pre-fetched GitHub audience
 * (null for reply_and_wait, which needs no reads), produce a transparent preview
 * result that either carries a register-ready `expanded` payload or fails closed
 * with `needs_input` / `reply_succeeded_tracking_not_armed`.
 */
export function buildTrackingPreview(
  input: GitHubTrackingPreviewInput,
  audience: GitHubTrackingAudience | null,
): GitHubTrackingPreviewResult {
  const { sources, teams } = collectSources(input, audience);
  const authorLogins = dedupeLogins(sources.flatMap((s) => s.logins));
  const callerProvidedLogins = (input.additionalLogins ?? []).some((l) => l.trim().length > 0);
  const label = subjectLabel(input.subject);

  // Fail-closed gate. Order matters: teams first (caller must acknowledge an
  // unresolvable team), then size (empty / >20).
  const teamsBlock = teams.length > 0 && !callerProvidedLogins;
  const tooMany = authorLogins.length > MAX_AUDIENCE;
  const empty = authorLogins.length === 0;

  const notArmed = (reason: string): GitHubTrackingPreviewResult => {
    // reply_and_wait after an external reply: surface the loud, specific status.
    const status: GitHubTrackingPreviewStatus =
      input.intent === 'reply_and_wait' && input.replyAlreadySent === true
        ? 'reply_succeeded_tracking_not_armed'
        : 'needs_input';
    const preface =
      status === 'reply_succeeded_tracking_not_armed'
        ? `Your reply on ${label} is posted, but tracking was NOT armed: `
        : `Cannot arm tracking for ${label}: `;
    return {
      status,
      humanSummary: preface + reason,
      resolvedAudience: {
        authorLogins,
        sources,
        unresolved: {
          ...(teams.length > 0 ? { teams } : {}),
          reason,
        },
      },
      baselineFrozen: false,
    };
  };

  if (teamsBlock) {
    return notArmed(
      `requested team reviewer(s) [${teams.join(', ')}] cannot be expanded to exact members. ` +
        'Re-run with the specific logins you are waiting for in additionalLogins.',
    );
  }
  if (empty) {
    const detail =
      input.intent === 'reply_and_wait'
        ? 'reply_and_wait requires at least one exact login in additionalLogins.'
        : 'no exact audience could be resolved. Add exact logins in additionalLogins.';
    return notArmed(detail);
  }
  if (tooMany) {
    return notArmed(
      `resolved audience has ${authorLogins.length} logins (max ${MAX_AUDIENCE}). ` +
        'Re-run with overrideLogins set to the exact reviewer subset (≤20) you want — ' +
        'additionalLogins only unions and cannot narrow an overflow.',
    );
  }

  const when = buildWhenPredicates(input, authorLogins);
  const expanded = buildExpanded(input, when);
  const autoRenew = resolveAutoRenew(input);
  const renewNote = autoRenew ? 'auto-renews each generation' : 'single-fire';
  const teamNote = teams.length > 0 ? ` (requested team(s) [${teams.join(', ')}] acknowledged via exact logins)` : '';
  return {
    status: 'register_ready',
    humanSummary: `Will track ${label} for [${authorLogins.join(', ')}] via ${when
      .map((p) => p.kind)
      .join(' | ')}; ${renewNote}${teamNote}. Feed expanded.args to ${expanded.registerTool} to install.`,
    resolvedAudience: {
      authorLogins,
      sources,
      unresolved: teams.length > 0 ? { teams } : {},
    },
    expanded,
    baselineFrozen: false,
  };
}
