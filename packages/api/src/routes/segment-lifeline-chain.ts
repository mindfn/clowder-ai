/**
 * F257 Phase D — Version lifecycle chain builder.
 *
 * Pure function: assembles a VersionEpoch[] chain from raw store data.
 * No Redis access — receives pre-fetched data as input.
 *
 * Chain model (co-creator product direction, 2026-07-14):
 *   v1 → tracing → eval → governance(approve) → v2 → tracing → ...
 *
 * The chain is a single continuous line. Governance approve naturally produces
 * the next version. User edits and version activation are events ON the chain,
 * not separate chains.
 */

import type {
  EvalStageSummary,
  GovernanceStageSummary,
  LifecycleEvent,
  OverrideChangeEvent,
  TracingStageSummary,
  VersionEpoch,
  VersionEpochStatus,
  VersionOrigin,
} from '@cat-cafe/shared';
import type { CachedJudgment } from '../domains/prompt-hooks/SegmentJudgmentCache.js';

// ---------------------------------------------------------------------------
// Input types (pre-fetched data from stores)
// ---------------------------------------------------------------------------

export interface SegmentObservationInput {
  timestamp: number;
  version: number | null;
}

export interface ChainBuilderInput {
  /** Manifest baseline version (from hook.yaml). */
  manifestVersion: number;
  /** Override change events filtered for this segment, sorted by timestamp. */
  overrideEvents: OverrideChangeEvent[];
  /** Observations (timestamp + version) within the query window. */
  observations: SegmentObservationInput[];
  /** Eval judgment history (all judgments, oldest first). P1-2: per-version eval. */
  judgmentHistory?: CachedJudgment[];
  /** Single judgment — backward compat. Use judgmentHistory for multi-eval. */
  cachedJudgment?: CachedJudgment | null;
  /** Current content version from override state. */
  currentContentVersion: number | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the version lifecycle chain from raw data.
 *
 * Algorithm:
 * 1. Start with manifest v1 epoch
 * 2. Walk override events chronologically — content-set creates user-edit
 *    events and may start new version epochs
 * 3. Attach observation counts to each epoch's tracing stage
 * 4. Attach cached judgment to the appropriate epoch's eval stage
 * 5. Derive each epoch's status from available data
 */
export function buildVersionChain(input: ChainBuilderInput): VersionEpoch[] {
  const { manifestVersion, overrideEvents, observations, currentContentVersion } = input;

  // Merge judgment sources: judgmentHistory (P1-2) takes precedence, cachedJudgment for compat
  const allJudgments: CachedJudgment[] = input.judgmentHistory ?? (input.cachedJudgment ? [input.cachedJudgment] : []);

  // Single-pass event reducer: builds epochs AND activation timeline together.
  // This avoids timestamp-based lookups that break on same-ms events (R4 P1-1).
  const { epochs, timeline } = buildEpochsAndTimeline(manifestVersion, overrideEvents);

  // Attach observations using activation timeline
  attachObservations(epochs, observations, timeline);

  // Attach eval judgments — each distributed to its active epoch (P1-2)
  attachJudgments(epochs, allJudgments, timeline);

  // Mark active version from activation timeline (P1-3).
  // Timeline's last entry = currently active epoch. Handles version-activate,
  // rollback, content-clear — all encoded as timeline transitions.
  markActiveFromTimeline(epochs, timeline);

  // Derive status for each epoch
  for (const epoch of epochs) {
    epoch.status = deriveStatus(epoch);
  }

  return epochs;
}

// ---------------------------------------------------------------------------
// Single-pass event reducer: epochs + activation timeline (R4 fix)
// ---------------------------------------------------------------------------

/** A point in the activation timeline: from this timestamp, epochIndex is active. */
interface ActivationPoint {
  timestamp: number;
  epochIndex: number;
}

/**
 * Build epochs AND activation timeline in one pass through override events.
 *
 * Why single-pass (R4 P1-1): separate construction required timestamp-based
 * findIndex lookup to correlate events → epochs. This broke on same-ms
 * content-set events (findIndex always returned first match). Merging the
 * reducer means epochIndex is known at creation time — no lookup needed.
 *
 * Activation state machine:
 *   - t=0: manifest (epoch 0) active
 *   - content-set@T: new override epoch active from T
 *   - rollback@T: manifest (epoch 0) reactivated from T
 *   - content-clear@T: manifest (epoch 0) reactivated from T
 *   - version-activate@T: target version epoch reactivated from T (P1-3)
 *   - enable/disable: no activation change
 */
function buildEpochsAndTimeline(
  manifestVersion: number,
  events: OverrideChangeEvent[],
): { epochs: VersionEpoch[]; timeline: ActivationPoint[] } {
  const epochs: VersionEpoch[] = [createEpoch(manifestVersion, 'manifest', 0)];
  const timeline: ActivationPoint[] = [{ timestamp: 0, epochIndex: 0 }];

  for (const event of events) {
    const latestEpoch = epochs[epochs.length - 1];

    if (event.action === 'content-set') {
      const newVersion = latestEpoch.version + 1;
      const origin: VersionOrigin = event.source === 'operator' ? 'user-create' : 'auto-iterate';

      latestEpoch.events.push({
        eventId: event.eventId,
        kind: origin === 'user-create' ? 'user-create' : 'auto-iterate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: `v${latestEpoch.version} → v${newVersion}`,
      });

      const newEpoch = createEpoch(newVersion, origin, event.timestamp);
      const newIndex = epochs.length;
      epochs.push(newEpoch);
      timeline.push({ timestamp: event.timestamp, epochIndex: newIndex });
    } else if (event.action === 'rollback' || event.action === 'content-clear') {
      // Both rollback and content-clear reactivate manifest baseline
      latestEpoch.events.push({
        eventId: event.eventId,
        kind: 'version-activate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail:
          event.action === 'rollback'
            ? `rolled back to v${manifestVersion}`
            : `content cleared, reverted to v${manifestVersion}`,
      });
      timeline.push({ timestamp: event.timestamp, epochIndex: 0 });
    } else if (event.action === 'version-activate') {
      // P1-3: explicit version switch — find target epoch by version number
      const targetVersion = event.contentVersion;
      if (targetVersion != null) {
        const targetIdx = epochs.findIndex((e) => e.version === targetVersion);
        if (targetIdx >= 0) {
          latestEpoch.events.push({
            eventId: event.eventId,
            kind: 'version-activate',
            timestamp: event.timestamp,
            actorId: event.actorId,
            detail: `activated v${targetVersion}`,
          });
          timeline.push({ timestamp: event.timestamp, epochIndex: targetIdx });
        }
      }
    } else if (event.action === 'enable' || event.action === 'disable') {
      const kind = event.action === 'enable' ? 'governance-approve' : 'eval-reject';
      latestEpoch.events.push({
        eventId: event.eventId,
        kind: kind as LifecycleEvent['kind'],
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: event.action === 'enable' ? 'enabled' : 'disabled',
      });
    }
  }

  return { epochs, timeline };
}

function createEpoch(version: number, origin: VersionOrigin, startedAt: number): VersionEpoch {
  return {
    version,
    origin,
    startedAt,
    status: 'idle',
    isActive: false,
    tracing: null,
    eval: null,
    governance: null,
    events: [],
  };
}

/** Resolve which epoch was active at a given timestamp using the activation timeline. */
function resolveActiveEpochAt(timeline: ActivationPoint[], timestamp: number, epochs: VersionEpoch[]): VersionEpoch {
  let idx = 0;
  for (const point of timeline) {
    if (point.timestamp <= timestamp) {
      idx = point.epochIndex;
    } else {
      break;
    }
  }
  return epochs[idx] ?? epochs[0];
}

// ---------------------------------------------------------------------------
// Observation attachment
// ---------------------------------------------------------------------------

function attachObservations(
  epochs: VersionEpoch[],
  observations: SegmentObservationInput[],
  timeline: ActivationPoint[],
): void {
  if (observations.length === 0) return;

  for (const obs of observations) {
    const epoch = resolveActiveEpochAt(timeline, obs.timestamp, epochs);

    if (!epoch.tracing) {
      epoch.tracing = { observationCount: 0, firstAt: null, lastAt: null };
    }

    epoch.tracing.observationCount++;
    if (epoch.tracing.firstAt === null || obs.timestamp < epoch.tracing.firstAt) {
      epoch.tracing.firstAt = obs.timestamp;
    }
    if (epoch.tracing.lastAt === null || obs.timestamp > epoch.tracing.lastAt) {
      epoch.tracing.lastAt = obs.timestamp;
    }
  }
}

// ---------------------------------------------------------------------------
// Active epoch marking
// ---------------------------------------------------------------------------

/**
 * Mark the active epoch from the activation timeline (P1-3).
 *
 * The last entry in the timeline determines which epoch is currently active.
 * This naturally handles all activation transitions: content-set, rollback,
 * content-clear, and version-activate — all encoded as timeline entries.
 */
function markActiveFromTimeline(epochs: VersionEpoch[], timeline: ActivationPoint[]): void {
  if (epochs.length === 0 || timeline.length === 0) return;
  const lastPoint = timeline[timeline.length - 1];
  const activeIdx = lastPoint.epochIndex;
  if (activeIdx >= 0 && activeIdx < epochs.length) {
    epochs[activeIdx].isActive = true;
  }
}

// ---------------------------------------------------------------------------
// Judgment attachment
// ---------------------------------------------------------------------------

/**
 * Attach judgment history to epochs (P1-2: per-version eval).
 *
 * Each judgment is distributed to the epoch that was active at evaluatedAt
 * via the activation timeline. When multiple judgments map to the same epoch,
 * the latest (highest evaluatedAt) wins — consistent with "latest eval is
 * the current truth for that version".
 *
 * Governance derivation applies to the winning judgment per epoch.
 */
function attachJudgments(epochs: VersionEpoch[], judgments: CachedJudgment[], timeline: ActivationPoint[]): void {
  if (epochs.length === 0 || judgments.length === 0) return;

  for (const judgment of judgments) {
    const target = resolveActiveEpochAt(timeline, judgment.evaluatedAt, epochs);
    const existing = target.eval;

    // Latest-wins: only overwrite if this judgment is newer
    if (existing && existing.evaluatedAt !== null && existing.evaluatedAt >= judgment.evaluatedAt) {
      continue;
    }

    target.eval = {
      verdict: judgment.verdict,
      injectionCount: judgment.injectionCount,
      violationCount: judgment.violationCount,
      evaluatedAt: judgment.evaluatedAt,
    };

    // Governance derivation from the winning judgment
    if (judgment.verdict === 'alive' || judgment.verdict === 'dormant') {
      target.governance = { decision: 'pending', decidedAt: null, actorId: null };
    } else {
      // Clear governance if newer judgment doesn't warrant it
      target.governance = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(epoch: VersionEpoch): VersionEpochStatus {
  // Check governance first (most advanced stage)
  if (epoch.governance?.decision === 'approved') return 'governance-approved';
  if (epoch.governance?.decision === 'pending') return 'governance-pending';

  // Check eval
  if (epoch.eval) {
    if (epoch.eval.verdict === 'alive') return 'eval-pass';
    if (epoch.eval.verdict === 'dormant' || epoch.eval.verdict === 'retire-candidate') {
      return 'eval-reject';
    }
    return 'eval-pending';
  }

  // Check tracing
  if (epoch.tracing && epoch.tracing.observationCount > 0) return 'tracing';

  return 'idle';
}

// ---------------------------------------------------------------------------
// Backward-compat status
// ---------------------------------------------------------------------------

/** Derive the legacy status field from the chain. */
export function deriveCurrentStatus(chain: VersionEpoch[]): 'idle' | 'tracing' | 'evaluated' {
  const active = chain.find((e) => e.isActive) ?? chain[chain.length - 1];
  if (!active) return 'idle';
  if (active.eval) return 'evaluated';
  if (active.tracing && active.tracing.observationCount > 0) return 'tracing';
  return 'idle';
}
