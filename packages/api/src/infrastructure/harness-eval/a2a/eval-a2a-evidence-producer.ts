/**
 * F167 eval:a2a evidence producer.
 *
 * Materializes fresh `snapshots/*.yaml` and `attributions/*.yaml` from
 * live F167 telemetry so the daily eval cat can pass valid `sourceRefs`
 * to `cat_cafe_publish_verdict`.
 *
 * Background (why this exists):
 *   `a2a-generator-adapter.ts` reads pre-materialized YAML files from
 *   `liveHarnessFeedbackRoot/snapshots/` + `attributions/`. Those dirs
 *   are gitignored — they must be written by a live producer BEFORE the
 *   eval cat calls `publish_verdict`. Without this producer every daily
 *   run gets `evidence_not_found` and falls back to the stale 2026-06-17
 *   bundle (clowder-ai#eval-a2a build verdict chain, PR #20).
 *
 * File-size boundary: telemetry assembly + file I/O only. YAML formatting
 * lives in eval-a2a-yaml-formatter.ts. Snapshot/attribution generation
 * lives in f167-eval.ts + attribution.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClaimGroundingEvent } from '../../grounding/types.js';
import { generateAttributionReport } from '../attribution.js';
import { generateF167Snapshot } from '../f167-eval.js';
import type { EvalMetricsHistoryResponse, EvalTraceStoreStats, EvalTracesResponse } from '../telemetry-adapter.js';
import { formatAttributionYaml, formatSnapshotYaml } from './eval-a2a-yaml-formatter.js';

export interface EvalA2aEvidenceProducerDeps {
  /** Absolute path to `docs/harness-feedback` in the live checkout. */
  harnessFeedbackRoot: string;
  /** F153 trace ring buffer — null when OTel is disabled. */
  traceStore: TelemetryTraceStoreShape | null;
  /** Prometheus metrics text reader — null when OTel is disabled. */
  getMetricsText?: (() => Promise<string>) | null;
  /** Time-series metrics store — null when not available. */
  metricsSnapshotStore?: MetricsSnapshotStoreShape | null;
  /** F167 Phase O grounding sample store — null when not available. */
  groundingSampleStore?: GroundingSampleStoreShape | null;
}

/** Minimal subset of LocalTraceStore needed by the evidence producer. */
export interface TelemetryTraceStoreShape {
  query(opts: { limit: number }): EvalTracesResponse['spans'];
  stats(): EvalTraceStoreStats;
}

/** Minimal subset of MetricsSnapshotStore needed by the evidence producer. */
export interface MetricsSnapshotStoreShape {
  query(since?: number, limit?: number): EvalMetricsHistoryResponse['snapshots'];
}

/** Minimal subset of IGroundingSampleStore needed by the evidence producer. */
export interface GroundingSampleStoreShape {
  getSamples(): ClaimGroundingEvent[] | Promise<ClaimGroundingEvent[]>;
}

export interface EvalA2aEvidenceProducerResult {
  /** Basename of the written snapshot YAML (inside snapshots/). */
  snapshotName: string;
  /** Basename of the written attribution YAML (inside attributions/). */
  attributionName: string;
  /** ISO datetime the evidence was generated at. */
  generatedAt: string;
}

/**
 * Generate F167 snapshot + attribution from live telemetry and write the
 * YAML artifacts to `harnessFeedbackRoot/snapshots/` + `attributions/`.
 *
 * Returns the artifact basenames so the eval cat can pass them as
 * `sourceRefs: { snapshotName, attributionName }` to `cat_cafe_publish_verdict`.
 * Returns null when OTel is disabled (no metrics text reader) — caller should
 * skip evidence production and fall back to the "no-data" invocation path.
 */
export async function produceEvalA2aEvidence(
  deps: EvalA2aEvidenceProducerDeps,
): Promise<EvalA2aEvidenceProducerResult | null> {
  if (!deps.getMetricsText || !deps.traceStore) {
    // OTel is disabled — no live counter data available.
    return null;
  }

  const traceStore = deps.traceStore;
  const traceStats = traceStore.stats();
  const allSpans = traceStore.query({ limit: traceStats.maxSpans });
  const traces: EvalTracesResponse = { spans: allSpans, count: allSpans.length };

  // Parse Prometheus text into a metric key → value map.
  const { parsePrometheusText } = await import('../../telemetry/metrics-snapshot-store.js');
  const metricsText = await deps.getMetricsText();
  const metrics = parsePrometheusText(metricsText);

  // Build metrics history (empty if store unavailable).
  const metricsHistory: EvalMetricsHistoryResponse = deps.metricsSnapshotStore
    ? { snapshots: deps.metricsSnapshotStore.query(), count: deps.metricsSnapshotStore.query().length }
    : { snapshots: [], count: 0 };

  // F167 Phase O: grounding sample evidence (may be empty).
  const groundingSamples: ClaimGroundingEvent[] = deps.groundingSampleStore
    ? await Promise.resolve(deps.groundingSampleStore.getSamples())
    : [];

  // Counter-window: process boot → now (F167 sibling-PR).
  const uptimeSec = process.uptime();
  const processStartMs = Date.now() - Math.floor(uptimeSec * 1000);

  const snapshot = generateF167Snapshot({
    traces,
    metrics,
    metricsHistory,
    traceStats,
    groundingSamples,
    processStartMs,
    processUptimeSec: uptimeSec,
  });

  const attribution = generateAttributionReport({
    featureId: snapshot.featureId,
    snapshot: { components: snapshot.components },
  });

  // Use evalSnapshotId date for consistent filenames.
  const evalDate = snapshot.generatedAt.slice(0, 10);
  const snapshotName = `eval-F167-${evalDate}.yaml`;
  const attributionName = `eval-F167-${evalDate}-attribution.yaml`;

  const snapshotsDir = resolve(deps.harnessFeedbackRoot, 'snapshots');
  const attributionsDir = resolve(deps.harnessFeedbackRoot, 'attributions');
  mkdirSync(snapshotsDir, { recursive: true });
  mkdirSync(attributionsDir, { recursive: true });

  writeFileSync(resolve(snapshotsDir, snapshotName), formatSnapshotYaml(snapshot));
  writeFileSync(resolve(attributionsDir, attributionName), formatAttributionYaml(attribution));

  return { snapshotName, attributionName, generatedAt: snapshot.generatedAt };
}
