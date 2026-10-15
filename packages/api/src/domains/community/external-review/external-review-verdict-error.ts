export type ExternalReviewVerdictErrorCode =
  | 'not_configured'
  | 'observe_only'
  | 'stale_head'
  | 'projection_unavailable'
  | 'wrong_principal'
  | 'subject_terminal'
  | 'head_not_ready'
  | 'invalid_delivery_proof'
  | 'invalid_pending_reason'
  | 'delivery_regression'
  | 'verdict_conflict'
  | 'action_lease_required'
  | 'action_lease_mismatch'
  | 'action_lease_preflight_unavailable'
  | 'stale_action_lease';

export class ExternalReviewVerdictError extends Error {
  constructor(
    readonly code: ExternalReviewVerdictErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalReviewVerdictError';
  }
}
