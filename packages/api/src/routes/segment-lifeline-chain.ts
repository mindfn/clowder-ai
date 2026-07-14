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
  /** Cached eval judgment (latest), if any. */
  cachedJudgment: CachedJudgment | null;
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
  const { manifestVersion, overrideEvents, observations, cachedJudgment, currentContentVersion } = input;

  // Build version transition timeline from override events
  const epochs = buildEpochsFromEvents(manifestVersion, overrideEvents);

  // Attach observations to epochs
  attachObservations(epochs, observations);

  // Attach eval judgment to the epoch that was current when eval ran
  if (cachedJudgment) {
    attachJudgment(epochs, cachedJudgment);
  }

  // Mark active version — state-based, not number-based.
  // If there's a current content override (contentVersion != null), the most
  // recently created override epoch is active. Otherwise manifest baseline.
  markActiveEpoch(epochs, currentContentVersion);

  // Derive status for each epoch
  for (const epoch of epochs) {
    epoch.status = deriveStatus(epoch);
  }

  return epochs;
}

// ---------------------------------------------------------------------------
// Epoch construction from override events
// ---------------------------------------------------------------------------

function buildEpochsFromEvents(manifestVersion: number, events: OverrideChangeEvent[]): VersionEpoch[] {
  const epochs: VersionEpoch[] = [];

  // Always start with the manifest baseline epoch
  const baseEpoch = createEpoch(manifestVersion, 'manifest', 0);
  epochs.push(baseEpoch);

  // Walk events chronologically
  for (const event of events) {
    const latestEpoch = epochs[epochs.length - 1];

    if (event.action === 'content-set') {
      // content-set with a new version → new epoch
      // The contentVersion in the event isn't directly available,
      // but each content-set increments the version.
      const newVersion = latestEpoch.version + 1;
      const origin: VersionOrigin = event.source === 'operator' ? 'user-create' : 'auto-iterate';

      // Record the edit event on the current epoch
      latestEpoch.events.push({
        eventId: event.eventId,
        kind: origin === 'user-create' ? 'user-create' : 'auto-iterate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: `v${latestEpoch.version} → v${newVersion}`,
      });

      // Start a new epoch
      const newEpoch = createEpoch(newVersion, origin, event.timestamp);
      epochs.push(newEpoch);
    } else if (event.action === 'rollback') {
      // Rollback to manifest baseline — version-activate event
      latestEpoch.events.push({
        eventId: event.eventId,
        kind: 'version-activate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: `rolled back to v${manifestVersion}`,
      });
    } else if (event.action === 'enable' || event.action === 'disable') {
      // Enable/disable → governance-related event
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

  return epochs;
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

// ---------------------------------------------------------------------------
// Observation attachment
// ---------------------------------------------------------------------------

function attachObservations(epochs: VersionEpoch[], observations: SegmentObservationInput[]): void {
  if (observations.length === 0) return;

  for (const obs of observations) {
    // Find the matching epoch by version, fallback to latest
    const epoch = findEpochForObservation(epochs, obs);
    if (!epoch) continue;

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

function findEpochForObservation(epochs: VersionEpoch[], obs: SegmentObservationInput): VersionEpoch | undefined {
  // Timestamp-based matching only — version numbers are unreliable because
  // contentVersion (1-based from HookRegistry) and epoch version (auto-incremented
  // from manifest baseline) use different namespaces and collide at value 1.
  // Same approach as attachJudgment() and markActiveEpoch().
  for (let i = epochs.length - 1; i >= 0; i--) {
    if (obs.timestamp >= epochs[i].startedAt) return epochs[i];
  }
  // Ultimate fallback: first epoch
  return epochs[0];
}

// ---------------------------------------------------------------------------
// Active epoch marking
// ---------------------------------------------------------------------------

/**
 * Mark the active epoch based on current override state.
 *
 * State-based approach (not number-matching) — avoids version collision
 * between manifestVersion and contentVersion (both can be 1).
 *
 * Rules:
 *   - contentVersion != null → latest content-set epoch is active
 *   - contentVersion == null → manifest baseline is active
 */
function markActiveEpoch(epochs: VersionEpoch[], currentContentVersion: number | null): void {
  if (currentContentVersion != null) {
    // Find the most recently created override epoch (latest content-set)
    for (let i = epochs.length - 1; i >= 0; i--) {
      if (epochs[i].origin !== 'manifest') {
        epochs[i].isActive = true;
        return;
      }
    }
  }
  // No active override (or no override epoch found) → manifest baseline
  if (epochs.length > 0) {
    epochs[0].isActive = true;
  }
}

// ---------------------------------------------------------------------------
// Judgment attachment
// ---------------------------------------------------------------------------

/**
 * Attach cached judgment to the epoch that was current when eval ran.
 *
 * Uses evaluatedAt timestamp to find the correct epoch, not version number
 * (version number is ambiguous: contentVersion=1 and manifestVersion=1 collide).
 */
function attachJudgment(epochs: VersionEpoch[], judgment: CachedJudgment): void {
  if (epochs.length === 0) return;

  // Find the epoch that was current at evaluation time:
  // the latest epoch whose startedAt <= evaluatedAt
  let target = epochs[0];
  for (const epoch of epochs) {
    if (epoch.startedAt <= judgment.evaluatedAt) {
      target = epoch;
    }
  }

  const evalSummary: EvalStageSummary = {
    verdict: judgment.verdict,
    injectionCount: judgment.injectionCount,
    violationCount: judgment.violationCount,
    evaluatedAt: judgment.evaluatedAt,
  };
  target.eval = evalSummary;

  // If verdict is alive/dormant → governance is pending
  if (judgment.verdict === 'alive' || judgment.verdict === 'dormant') {
    target.governance = { decision: 'pending', decidedAt: null, actorId: null };
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
