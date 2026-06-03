/**
 * F167 Path A: tests for buildA2aNoDataVerdictHandoff().
 *
 * These tests pin the contract that the eval cat would otherwise have to
 * re-implement by hand in markdown — see hand-written
 * 2026-06-01..06-03-eval-a2a-source-adapter-* verdicts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
} from '../../dist/infrastructure/harness-eval/verdict-handoff.js';
import { buildA2aNoDataVerdictHandoff } from '../../dist/infrastructure/harness-eval/eval-a2a-no-data-adapter.js';

const domain = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  systemThreadId: 'thread_eval_a2a',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: ['harness-fit-digest'],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
};

function baseInput(overrides = {}) {
  return {
    domain,
    verdictId: '2026-06-04-eval-a2a-source-adapter-unavailable',
    generatedAt: '2026-06-04T03:00:00.000Z',
    window: { startMs: 1780455600000, endMs: 1780542000000, durationHours: 24 },
    noDataReason: {
      summary: 'OTel init failed because TELEMETRY_HMAC_SALT is missing under profile-driven NODE_ENV=production startup.',
      endpointProbes: [
        { endpoint: '/api/telemetry/metrics', status: 503, result: 'Metrics reader not available' },
        { endpoint: '/api/telemetry/metrics/history', status: 503, result: 'Metrics snapshot store not available' },
        { endpoint: '/api/telemetry/traces', status: 503, result: 'Trace store not available (OTel may be disabled)' },
        { endpoint: '/api/telemetry/traces/stats', status: 503, result: 'Trace store not available' },
      ],
    },
    legacyScheduledTaskStatus: {
      taskIds: ['harness-fit-digest'],
      cleanupStatus: 'disabled',
      activeLegacyOverlap: 0,
    },
    dailySchedulerStatus: {
      currentSlot: '2026-06-04T03:00:00.000Z',
      previousSlot: '2026-06-03T03:00:00.000Z',
      invocationsPerSlot: { '2026-06-03': 1, '2026-06-04': 1 },
      duplicateCronSlotFires: 0,
    },
    ...overrides,
  };
}

describe('eval:a2a no-data verdict builder', () => {
  it('produces a packet that parses and survives the cross-thread handoff gate', () => {
    const packet = buildA2aNoDataVerdictHandoff(baseInput());

    // parsing already happened inside the builder, but re-parse here to pin
    // the public contract that consumers can round-trip the result.
    const reparsed = parseVerdictHandoffPacket(packet);
    assert.equal(reparsed.verdict, 'fix');
    assert.equal(reparsed.domainId, 'eval:a2a');
    assert.equal(reparsed.dailyTrend.direction, 'regressed');

    const handoffDecision = assertCanCrossThreadHandoff(packet);
    assert.equal(handoffDecision.ok, true);
  });

  it('routes the packet to the F167 owner cat declared on the domain', () => {
    const packet = buildA2aNoDataVerdictHandoff(baseInput());
    assert.equal(packet.ownerAsk.targetFeatureId, 'F167');
    assert.equal(packet.ownerAsk.targetOwnerCatId, 'opus47');
    assert.equal(packet.harnessUnderEval.componentId, 'source-adapter');
    assert.equal(packet.harnessUnderEval.name, 'f167-runtime-eval telemetry source adapter');
  });

  it('encodes each 503 probe into the trace refs and an endpoint-specific metric ref', () => {
    const packet = buildA2aNoDataVerdictHandoff(baseInput());

    for (const probe of [
      '/api/telemetry/metrics',
      '/api/telemetry/metrics/history',
      '/api/telemetry/traces',
      '/api/telemetry/traces/stats',
    ]) {
      assert.ok(
        packet.evidencePacket.sampleTraceRefs.some((ref) => ref.startsWith(`endpoint:${probe}=503`)),
        `expected sampleTraceRefs to contain probe ${probe}, got ${JSON.stringify(packet.evidencePacket.sampleTraceRefs)}`,
      );
    }

    assert.ok(packet.evidencePacket.metricRefs.includes('telemetry.metrics_reader_unavailable'));
    assert.ok(packet.evidencePacket.metricRefs.includes('telemetry.metrics_snapshot_store_unavailable'));
    assert.ok(packet.evidencePacket.metricRefs.includes('telemetry.trace_store_unavailable'));
    assert.ok(packet.evidencePacket.metricRefs.includes('telemetry.source_adapter_unavailable'));

    // current trend reflects the 4 unavailable probes
    assert.equal(packet.dailyTrend.current.source_adapter_available, 0);
    assert.equal(packet.dailyTrend.current.telemetry_endpoint_unavailable_count, 4);
    assert.equal(packet.dailyTrend.current.duplicate_trigger_count, 0);
  });

  it('treats /health 200-with-null-stores as an unavailable signal, not a healthy one', () => {
    const input = baseInput({
      noDataReason: {
        summary: '/health falsely reports healthy while stores are null.',
        endpointProbes: [
          { endpoint: '/api/telemetry/metrics', status: 503, result: 'Metrics reader not available' },
          {
            endpoint: '/api/telemetry/health',
            status: 200,
            result: 'healthy, traceStore=null, metricsSnapshotStore=null',
          },
        ],
      },
    });
    const packet = buildA2aNoDataVerdictHandoff(input);

    assert.ok(
      packet.evidencePacket.metricRefs.includes('telemetry.health_false_healthy_with_null_stores'),
      'expected the false-healthy /health probe to map to its dedicated metric ref',
    );
    // Both probes (503 metrics + 200 false-healthy) must count as unavailable.
    assert.equal(packet.dailyTrend.current.telemetry_endpoint_unavailable_count, 2);
  });

  it('reflects closure-unmet context when a previous verdict is still open', () => {
    const input = baseInput({
      previousVerdict: {
        packetId: 'vhp_eval_a2a_2026_06_03_source_adapter_closure_unmet',
        closureCondition: 'next eval can fetch metrics, metrics history, traces, and trace stats successfully',
        closureMet: false,
        reason: 'Telemetry stores remain unavailable on 2026-06-04.',
      },
      ownerActionStatus: {
        branch: 'feat/f167-no-data-resilience',
        latestCommit: '988545163',
        reviewStatus: 'codex_approved_path_c',
      },
    });
    const packet = buildA2aNoDataVerdictHandoff(input);

    assert.match(packet.phenomenon, /previous closure unmet/i);
    assert.match(
      packet.ownerAsk.requestedAction,
      /feat\/f167-no-data-resilience@988545163/,
      'requested action should point at the owner branch when closure is unmet',
    );
    assert.ok(
      packet.evidencePacket.sampleTraceRefs.some((ref) =>
        ref.startsWith('previous_verdict:vhp_eval_a2a_2026_06_03_source_adapter_closure_unmet'),
      ),
    );
    assert.ok(
      packet.evidencePacket.sampleTraceRefs.some((ref) =>
        ref.startsWith('branch:feat/f167-no-data-resilience@988545163'),
      ),
    );
    assert.equal(packet.dailyTrend.current.previous_verdict_closure_met, 0);
    assert.equal(packet.dailyTrend.current.owner_action_observed, 1);
    assert.ok(packet.evidencePacket.metricRefs.includes('owner_action_observed'));
  });

  it('extends the closure condition when legacy cleanup is not yet disabled', () => {
    const input = baseInput({
      legacyScheduledTaskStatus: {
        taskIds: ['harness-fit-digest'],
        cleanupStatus: 'dry_run_ready',
        activeLegacyOverlap: 1,
      },
    });
    const packet = buildA2aNoDataVerdictHandoff(input);
    assert.match(
      packet.acceptanceReevalPlan.closureCondition,
      /harness-fit-digest.*disabled cleanup status/i,
    );
    assert.equal(packet.dailyTrend.current.legacy_task_overlap_count, 1);
  });

  it('rejects input with no endpoint probes — at least one probe must justify the no-data verdict', () => {
    assert.throws(
      () =>
        buildA2aNoDataVerdictHandoff(
          baseInput({
            noDataReason: { summary: 'no probes attached', endpointProbes: [] },
          }),
        ),
      /at least one endpoint probe/,
    );
  });

  it('sets the next re-eval timestamp using the domain SLA window', () => {
    const packet = buildA2aNoDataVerdictHandoff(baseInput());
    const expected = new Date(Date.parse('2026-06-04T03:00:00.000Z') + 72 * 3600 * 1000).toISOString();
    assert.equal(packet.acceptanceReevalPlan.nextEvalAt, expected);
  });
});
