/**
 * F257 Harness Ledger — run snapshot provider (KD-17 snapshot-first pattern).
 *
 * Produces a normalized guard-rejection-event snapshot BEFORE the eval cat
 * is invoked. The eval cat receives the snapshot summary in its invocation
 * content (evidence-first, not blind). The generator adapter later reads
 * the SAME stored snapshot file (single-read by evalRunId, no re-query).
 *
 * Invariant: trigger produces → eval cat reads summary → generator reads
 * stored snapshot. Decision and artifact share one data source. Drift = 0.
 *
 * Storage: `harness-feedback/run-snapshots/<evalRunId>.json`
 * Fail-closed: Redis error in queryWindowStrict propagates (no false zero).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardRejectionEventLog } from './GuardRejectionEventLog.js';

/** Normalized per-guard aggregate in the stored snapshot. */
export interface GuardAggregate {
  count: number;
  kinds: string[];
}

/** Shape of the stored run snapshot (persisted JSON). */
export interface HarnessLedgerRunSnapshot {
  evalRunId: string;
  producedAt: string;
  window: {
    startMs: number;
    endMs: number;
    durationHours: number;
  };
  totalEvents: number;
  byKind: Record<string, number>;
  /** Per-guard aggregate — generator uses this for attribution findings. */
  byGuard: Record<string, GuardAggregate>;
  /** First N events for provenance anchoring (no raw payload, metadata only). */
  sampleAnchors: Array<{
    eventId: string;
    kind: string;
    guardId: string;
    timestamp: number;
  }>;
  /** how_counted — judgment schema v1 §2 alignment. */
  howCounted: 'zset-window-scan';
}

export interface ProduceSnapshotDeps {
  guardRejectionLog: GuardRejectionEventLog;
  harnessFeedbackRoot: string;
  /** Override window duration (default: 7 days). */
  windowMs?: number;
}

export interface ProduceSnapshotResult {
  evalRunId: string;
  storagePath: string;
  snapshot: HarnessLedgerRunSnapshot;
  /** Human-readable summary for eval invocation injection. */
  summary: string;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const SAMPLE_ANCHOR_LIMIT = 5;

export async function produceHarnessLedgerRunSnapshot(deps: ProduceSnapshotDeps): Promise<ProduceSnapshotResult> {
  const evalRunId = `hlr-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const windowStartMs = now - windowMs;

  // Fail-closed: queryWindowStrict propagates Redis errors.
  const events = await deps.guardRejectionLog.queryWindowStrict({
    since: windowStartMs,
    until: now,
  });

  // Aggregate by kind
  const byKind: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  // Aggregate by guard (with kinds per guard — generator needs this for attribution)
  const byGuard: Record<string, GuardAggregate> = {};
  for (const e of events) {
    const existing = byGuard[e.guardId];
    if (existing) {
      existing.count += 1;
      if (!existing.kinds.includes(e.kind)) existing.kinds.push(e.kind);
    } else {
      byGuard[e.guardId] = { count: 1, kinds: [e.kind] };
    }
  }

  const snapshot: HarnessLedgerRunSnapshot = {
    evalRunId,
    producedAt: new Date().toISOString(),
    window: {
      startMs: windowStartMs,
      endMs: now,
      durationHours: Math.round(windowMs / (3600 * 1000)),
    },
    totalEvents: events.length,
    byKind,
    byGuard,
    sampleAnchors: events.slice(0, SAMPLE_ANCHOR_LIMIT).map((e) => ({
      eventId: e.eventId,
      kind: e.kind,
      guardId: e.guardId,
      timestamp: e.timestamp,
    })),
    howCounted: 'zset-window-scan',
  };

  // Persist snapshot to filesystem (generator reads by evalRunId).
  const dir = join(deps.harnessFeedbackRoot, 'run-snapshots');
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${evalRunId}.json`);
  writeFileSync(storagePath, JSON.stringify(snapshot, null, 2));

  // Build human-readable summary for eval cat injection.
  const guardSummary = Object.entries(byGuard)
    .map(([g, agg]) => `  - ${g}: ${agg.count} event(s) [${agg.kinds.join(', ')}]`)
    .join('\n');
  const summary = [
    `### Pre-computed Guard Rejection Snapshot (evalRunId: ${evalRunId})`,
    '',
    `- **Window**: ${snapshot.window.durationHours}h [${new Date(windowStartMs).toISOString()} → ${new Date(now).toISOString()})`,
    `- **Total events**: ${events.length}`,
    events.length > 0
      ? `- **By guard**:\n${guardSummary}`
      : '- No guard rejection events in this window (baseline accumulation phase)',
    '',
    `Use \`evalRunId: "${evalRunId}"\` in your sourceRefs when publishing.`,
  ].join('\n');

  return { evalRunId, storagePath, snapshot, summary };
}
