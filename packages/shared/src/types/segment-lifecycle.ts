/**
 * Segment Lifecycle Types — F257 Phase D Enhancement
 *
 * Read-model types for the version lifecycle chain:
 *   v1 → tracing → eval → governance → v2 → tracing → ...
 *
 * The chain is assembled at query time from existing stores
 * (InjectionTraceStore + HookOverrideStore + GuardRejectionEventLog).
 * No new write-path — pure projection.
 */

// ---------------------------------------------------------------------------
// Lifecycle event kinds
// ---------------------------------------------------------------------------

/**
 * Events that appear on the lifecycle chain.
 *
 * - auto-iterate:     governance approve → natural version bump
 * - user-create:      user manually creates a new version
 * - version-activate: user switches the active version
 * - user-edit:        user edits content of an existing version
 * - eval-pass:        eval judgment: keep / alive
 * - eval-reject:      eval judgment: needs attention
 * - governance-approve: governance decision to approve
 * - governance-reject:  operator-initiated disable (AF-5: distinct from eval-reject)
 */
export type LifecycleEventKind =
  | 'auto-iterate'
  | 'user-create'
  | 'version-activate'
  | 'user-edit'
  | 'eval-pass'
  | 'eval-reject'
  | 'governance-approve'
  | 'governance-reject';

/** A single event on the lifecycle chain. */
export interface LifecycleEvent {
  eventId: string;
  kind: LifecycleEventKind;
  timestamp: number;
  actorId: string;
  /** Short human-readable detail (e.g. "v1 → v2", "switched to v1"). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Stage summaries within a version epoch
// ---------------------------------------------------------------------------

/** Tracing stage summary: observation counts and time range. */
export interface TracingStageSummary {
  observationCount: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** Eval stage summary: latest judgment result or null if not yet evaluated. */
export interface EvalStageSummary {
  verdict: string | null;
  injectionCount: number;
  violationCount: number;
  evaluatedAt: number | null;
}

/** Governance stage summary: decision state. */
export interface GovernanceStageSummary {
  decision: 'approved' | 'pending' | null;
  decidedAt: number | null;
  actorId: string | null;
}

// ---------------------------------------------------------------------------
// Version epoch — one node in the chain
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a version epoch.
 *
 * idle:               segment exists but has no trace data yet
 * tracing:            actively being observed (has observations)
 * eval-pending:       tracing complete, awaiting eval
 * eval-pass:          eval passed
 * eval-reject:        eval rejected → will re-enter tracing
 * governance-pending: eval passed, awaiting governance
 * governance-approved: governance approved → may produce next version
 */
export type VersionEpochStatus =
  | 'idle'
  | 'tracing'
  | 'eval-pending'
  | 'eval-pass'
  | 'eval-reject'
  | 'governance-pending'
  | 'governance-approved';

/** How this version was created. */
export type VersionOrigin = 'manifest' | 'auto-iterate' | 'user-create';

/** A single version epoch in the lifecycle chain. */
export interface VersionEpoch {
  version: number;
  origin: VersionOrigin;
  startedAt: number;
  status: VersionEpochStatus;
  isActive: boolean;
  tracing: TracingStageSummary | null;
  eval: EvalStageSummary | null;
  governance: GovernanceStageSummary | null;
  events: LifecycleEvent[];
}

// ---------------------------------------------------------------------------
// API response
// ---------------------------------------------------------------------------

/** Full lifecycle response for GET /api/segment-lifeline/:segmentId. */
export interface SegmentLifecycleResponse {
  segmentId: string;
  segmentName: string;
  activeVersion: number;
  chain: VersionEpoch[];
  /** Backward-compat status summary. */
  currentStatus: 'idle' | 'tracing' | 'evaluated';
  window: { startMs: number; endMs: number };
}
