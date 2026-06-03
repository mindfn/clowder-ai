/**
 * F167 Path A: no-data verdict builder for `eval:a2a`.
 *
 * Why this exists separate from `eval-a2a-adapter.ts`:
 * - `buildA2aVerdictHandoff` assumes the source adapter produced a real
 *   `F167EvalInput` (traces + metrics + metrics history + trace stats).
 * - When the F153 telemetry source adapter is unavailable (e.g. OTel
 *   init failed because `TELEMETRY_HMAC_SALT` is missing under profile-
 *   driven startup), `generateF167Snapshot` cannot run, so the eval cat
 *   has been hand-writing snapshot/attribution/markdown for the
 *   2026-06-01..06-03 verdicts. Hand-written packets bypass the parsers
 *   and silently let trend continuity rot.
 * - This module gives the no-data path its own typed contract: instead of
 *   pretending "telemetry.metrics_reader_unavailable=1" is a real friction
 *   metric scraped from Prometheus, it carries explicit `endpointProbes`,
 *   `legacyScheduledTaskStatus`, `dailySchedulerStatus`, optional
 *   `ownerActionStatus`, and optional `previousVerdict.closureCheck`, and
 *   compiles them into a packet that satisfies the standard
 *   `verdictHandoffPacketSchema` + `assertCanCrossThreadHandoff` gates.
 *
 * The returned packet is always `verdict: 'fix'`, because by definition
 * an absent source adapter means the eval domain cannot demonstrate
 * health and the F167 owner must act (restore the adapter or accept a
 * graceful degradation). `keep_observe` would dishonestly mark missing
 * data as healthy — see codex review thread on 39d64d73b / 988545163.
 */

import {
  type EvalDomainRegistryEntry,
  parseEvalDomainRegistryEntry,
} from '../domain/eval-domain-registry.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';

export interface NoDataEndpointProbe {
  /** e.g. `/api/telemetry/metrics` */
  endpoint: string;
  /** HTTP status (503 for unavailable store, 200 + null-stores for false-healthy, etc). */
  status: number;
  /** Short server-reported reason — used verbatim as a sampleTraceRef. */
  result: string;
}

export interface NoDataReason {
  /** One-line human summary of why no data — embedded in the phenomenon. */
  summary: string;
  /** Probes that prove the source adapter is unavailable; at least one required. */
  endpointProbes: NoDataEndpointProbe[];
}

export interface NoDataLegacyScheduledTaskStatus {
  taskIds: string[];
  cleanupStatus: 'disabled' | 'dry_run_ready' | 'active';
  /** Number of legacy scheduled tasks that overlap the new daily eval slot. */
  activeLegacyOverlap: number;
}

export interface NoDataDailySchedulerStatus {
  /** ISO timestamp of the slot that triggered this eval. */
  currentSlot: string;
  /** Optional previous slot — when present, used for window framing. */
  previousSlot?: string;
  /** Per-day counts of `eval:a2a` invocations; values > 1 indicate cron double-fire. */
  invocationsPerSlot: Record<string, number>;
  /** Should be 0; > 0 surfaces as `duplicate_trigger_count` friction. */
  duplicateCronSlotFires: number;
}

export interface NoDataOwnerActionStatus {
  branch: string;
  latestCommit: string;
  reviewStatus: string;
  notes?: string;
}

export interface NoDataPreviousVerdict {
  packetId: string;
  closureCondition: string;
  closureMet: boolean;
  /** Why the closure condition is or is not met today. */
  reason: string;
}

export interface BuildA2aNoDataVerdictInput {
  domain: EvalDomainRegistryEntry;
  /** Slug-safe verdict id; reused for `snapshot:...` / `attribution:...` refs. */
  verdictId: string;
  /** ISO timestamp when this verdict was generated. */
  generatedAt: string;
  /** Evaluation window — durationHours feeds dailyTrend.window. */
  window: { startMs: number; endMs: number; durationHours: number };
  noDataReason: NoDataReason;
  legacyScheduledTaskStatus: NoDataLegacyScheduledTaskStatus;
  dailySchedulerStatus: NoDataDailySchedulerStatus;
  ownerActionStatus?: NoDataOwnerActionStatus;
  previousVerdict?: NoDataPreviousVerdict;
}

const SOURCE_ADAPTER_COMPONENT_ID = 'source-adapter';
const SOURCE_ADAPTER_COMPONENT_NAME = 'f167-runtime-eval telemetry source adapter';
const NO_DATA_FRICTION_METRIC = 'telemetry.source_adapter_unavailable';

/**
 * Build a no-data verdict packet that survives the standard verdict
 * handoff gates. Always emits `verdict: 'fix'` with `direction: 'regressed'`
 * because absent data is itself the friction signal.
 */
export function buildA2aNoDataVerdictHandoff(input: BuildA2aNoDataVerdictInput): VerdictHandoffPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  if (input.noDataReason.endpointProbes.length === 0) {
    throw new Error('no-data verdict requires at least one endpoint probe');
  }

  const targetFeatureId = domain.handoffTargetResolver.featureId;

  const metricRefs = buildMetricRefs(input);
  const sampleTraceRefs = buildSampleTraceRefs(input);
  const counterarguments = buildCounterarguments(input);
  const phenomenon = buildPhenomenon(input);
  const requestedAction = buildRequestedAction(input);
  const closureCondition = buildClosureCondition(input);

  const packetInput = {
    id: handoffPacketId(domain.domainId, input.verdictId),
    domainId: domain.domainId,
    createdAt: input.generatedAt,
    phenomenon,
    harnessUnderEval: {
      featureId: targetFeatureId,
      componentId: SOURCE_ADAPTER_COMPONENT_ID,
      name: SOURCE_ADAPTER_COMPONENT_NAME,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:bundle/${input.verdictId}/snapshot`],
      attributionRefs: [`attribution:bundle/${input.verdictId}/source-adapter-unavailable`],
      metricRefs,
      sampleTraceRefs,
    },
    dailyTrend: {
      window: `${input.window.durationHours}h`,
      current: buildCurrentTrend(input),
      baseline: buildBaselineTrend(input),
      threshold: {
        source_adapter_available: 1,
        telemetry_endpoint_unavailable_count: 0,
        duplicate_trigger_count: 0,
      },
      direction: 'regressed' as const,
    },
    rootCauseHypothesis: {
      summary: `source-adapter-unavailable: ${input.noDataReason.summary}`,
      confidence: 'high' as const,
      alternatives: buildAlternatives(input),
    },
    verdict: 'fix' as const,
    ownerAsk: {
      targetFeatureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction,
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(input.generatedAt, domain),
      closureCondition,
    },
    counterarguments,
  };

  const packet = parseVerdictHandoffPacket(packetInput);

  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    if (handoffDecision.reason) throw new Error(handoffDecision.reason);
    throw new Error('no-data verdict handoff packet is incomplete');
  }
  return packet;
}

function buildMetricRefs(input: BuildA2aNoDataVerdictInput): string[] {
  const refs = new Set<string>([NO_DATA_FRICTION_METRIC]);
  for (const probe of input.noDataReason.endpointProbes) {
    refs.add(metricRefForProbe(probe));
  }
  if (input.ownerActionStatus) refs.add('owner_action_observed');
  refs.add('legacy_task_overlap_count');
  refs.add('duplicate_trigger_count');
  return Array.from(refs);
}

function metricRefForProbe(probe: NoDataEndpointProbe): string {
  if (probe.endpoint.endsWith('/health') && probe.status === 200) {
    return 'telemetry.health_false_healthy_with_null_stores';
  }
  if (probe.endpoint.endsWith('/metrics/history')) return 'telemetry.metrics_snapshot_store_unavailable';
  if (probe.endpoint.endsWith('/metrics')) return 'telemetry.metrics_reader_unavailable';
  if (probe.endpoint.endsWith('/traces/stats') || probe.endpoint.endsWith('/traces'))
    return 'telemetry.trace_store_unavailable';
  return `telemetry.endpoint_unavailable:${probe.endpoint}`;
}

function buildSampleTraceRefs(input: BuildA2aNoDataVerdictInput): string[] {
  const refs: string[] = [];
  for (const probe of input.noDataReason.endpointProbes) {
    refs.push(`endpoint:${probe.endpoint}=${probe.status} ${probe.result}`);
  }
  for (const [day, count] of Object.entries(input.dailySchedulerStatus.invocationsPerSlot)) {
    refs.push(`scheduler:eval:a2a invocations on ${day}=${count}`);
  }
  if (input.ownerActionStatus) {
    refs.push(
      `branch:${input.ownerActionStatus.branch}@${input.ownerActionStatus.latestCommit} ${input.ownerActionStatus.reviewStatus}`,
    );
  }
  if (input.previousVerdict) {
    refs.push(
      `previous_verdict:${input.previousVerdict.packetId} closureMet=${input.previousVerdict.closureMet}`,
    );
  }
  return refs;
}

function buildCurrentTrend(input: BuildA2aNoDataVerdictInput): Record<string, number> {
  const trend: Record<string, number> = {
    source_adapter_available: 0,
    telemetry_endpoint_unavailable_count: countUnavailableProbes(input.noDataReason.endpointProbes),
    legacy_task_overlap_count: input.legacyScheduledTaskStatus.activeLegacyOverlap,
    duplicate_trigger_count: input.dailySchedulerStatus.duplicateCronSlotFires,
  };
  if (input.ownerActionStatus) trend.owner_action_observed = 1;
  if (input.previousVerdict) trend.previous_verdict_closure_met = input.previousVerdict.closureMet ? 1 : 0;
  return trend;
}

function buildBaselineTrend(input: BuildA2aNoDataVerdictInput): Record<string, number> {
  // Baseline says "what would healthy look like" — used by Eval Hub trend
  // direction logic. We don't fabricate historical numbers; we encode the
  // contract a working source adapter would have met.
  const baseline: Record<string, number> = {
    source_adapter_available: 1,
    telemetry_endpoint_unavailable_count: 0,
  };
  if (input.previousVerdict) baseline.previous_verdict_closure_met = 1;
  return baseline;
}

function countUnavailableProbes(probes: NoDataEndpointProbe[]): number {
  let count = 0;
  for (const probe of probes) {
    if (probe.status >= 500) count++;
    else if (probe.status === 200 && probe.endpoint.endsWith('/health') && /null|unavailable/i.test(probe.result)) {
      // False-healthy /health is itself an unavailable signal.
      count++;
    }
  }
  return count;
}

function buildAlternatives(input: BuildA2aNoDataVerdictInput): string[] {
  const alternatives: string[] = [];
  alternatives.push(
    'The currently running local API may not be the production acceptance environment; production could have telemetry stores enabled.',
  );
  if (input.dailySchedulerStatus.duplicateCronSlotFires === 0) {
    alternatives.push(
      `The daily scheduler is not duplicating eval:a2a: invocations per slot = ${JSON.stringify(input.dailySchedulerStatus.invocationsPerSlot)}.`,
    );
  }
  if (input.ownerActionStatus) {
    alternatives.push(
      `Owner action observed on ${input.ownerActionStatus.branch}@${input.ownerActionStatus.latestCommit} (${input.ownerActionStatus.reviewStatus}); closure still requires runtime acceptance.`,
    );
  }
  return alternatives;
}

function buildPhenomenon(input: BuildA2aNoDataVerdictInput): string {
  const unavailable = countUnavailableProbes(input.noDataReason.endpointProbes);
  const total = input.noDataReason.endpointProbes.length;
  const closureNote = input.previousVerdict && !input.previousVerdict.closureMet ? ' (previous closure unmet)' : '';
  return `eval:a2a source-adapter unavailable: ${unavailable}/${total} telemetry endpoints failed${closureNote}. ${input.noDataReason.summary}`;
}

function buildRequestedAction(input: BuildA2aNoDataVerdictInput): string {
  if (input.ownerActionStatus && input.previousVerdict && !input.previousVerdict.closureMet) {
    return `Continue owner action on ${input.ownerActionStatus.branch}@${input.ownerActionStatus.latestCommit}: merge or accept so the runtime closure condition can pass on the next re-eval.`;
  }
  return 'Restore the F153 telemetry source adapter, or land the no-data verdict generator path so eval:a2a no longer hand-writes its packet when telemetry is dark.';
}

function buildClosureCondition(input: BuildA2aNoDataVerdictInput): string {
  const conditions = [
    'next eval can fetch metrics, metrics history, traces, and trace stats successfully',
    'or emits a no-data verdict via this generator',
    'and /api/telemetry/health no longer returns 200 healthy with null stores when OTel is enabled',
    'and no duplicate daily cron slot fire',
  ];
  if (input.legacyScheduledTaskStatus.cleanupStatus !== 'disabled') {
    conditions.push(`and legacy tasks (${input.legacyScheduledTaskStatus.taskIds.join(', ')}) reach disabled cleanup status`);
  }
  return conditions.join('; ');
}

function buildCounterarguments(input: BuildA2aNoDataVerdictInput): string[] {
  const counter: string[] = [];
  counter.push(
    'A no-data verdict cannot prove component health; downgrade to keep_observe only after a real telemetry-backed snapshot lands.',
  );
  if (input.dailySchedulerStatus.duplicateCronSlotFires === 0 && input.legacyScheduledTaskStatus.activeLegacyOverlap === 0) {
    counter.push(
      'Scheduler and legacy-cleanup paths are healthy; the source-adapter outage does not affect the rest of the eval pipeline.',
    );
  }
  if (input.ownerActionStatus) {
    counter.push(
      'Owner action is in progress; this verdict should be read as closure-unmet, not no-action.',
    );
  }
  return counter;
}

function handoffPacketId(domainId: string, verdictId: string): string {
  return `vhp_${slugId(domainId)}_${slugId(verdictId)}`;
}

function slugId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function nextEvalAt(createdAt: string, domain: EvalDomainRegistryEntry): string {
  return new Date(Date.parse(createdAt) + domain.sla.reevalWithinHours * 3_600_000).toISOString();
}
