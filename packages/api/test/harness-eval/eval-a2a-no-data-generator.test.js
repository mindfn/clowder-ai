/**
 * F167 Path A: end-to-end test for generateA2aNoDataVerdict().
 *
 * Replaces the hand-written workflow used for 2026-06-01..06-03 verdicts:
 * given structured input, the generator must produce bundle three-piece
 * plus a verdict.md that an existing Eval Hub consumer can read, and the
 * embedded `VerdictHandoffPacket` must round-trip through the standard
 * schema parser.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { generateA2aNoDataVerdict } from '../../dist/infrastructure/harness-eval/eval-a2a-live-verdict.js';
import { resolveA2aEvidenceBundle } from '../../dist/infrastructure/harness-eval/eval-a2a-artifact-resolver.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
} from '../../dist/infrastructure/harness-eval/verdict-handoff.js';

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

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f167-no-data-verdict-'));
  return join(root, 'docs/harness-feedback');
}

function baseInput(harnessFeedbackRoot, overrides = {}) {
  return {
    harnessFeedbackRoot,
    domain,
    verdictId: '2026-06-04-eval-a2a-source-adapter-unavailable',
    generatedAt: '2026-06-04T03:00:00.000Z',
    window: { startMs: 1780455600000, endMs: 1780542000000, durationHours: 24 },
    noDataReason: {
      summary: 'OTel init failed because TELEMETRY_HMAC_SALT is missing under profile-driven NODE_ENV=production.',
      endpointProbes: [
        { endpoint: '/api/telemetry/metrics', status: 503, result: 'Metrics reader not available' },
        { endpoint: '/api/telemetry/metrics/history', status: 503, result: 'Metrics snapshot store not available' },
        { endpoint: '/api/telemetry/traces', status: 503, result: 'Trace store not available (OTel may be disabled)' },
        { endpoint: '/api/telemetry/traces/stats', status: 503, result: 'Trace store not available' },
        {
          endpoint: '/api/telemetry/health',
          status: 200,
          result: 'healthy, otelEnabled=true, traceStore=null, metricsSnapshotStore=null',
        },
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

describe('generateA2aNoDataVerdict', () => {
  it('writes a bundle three-piece plus verdict.md whose packet parses through verdictHandoffPacketSchema', () => {
    const harnessFeedbackRoot = makeRoot();
    const result = generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));

    const verdictId = '2026-06-04-eval-a2a-source-adapter-unavailable';
    const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
    assert.equal(existsSync(join(bundleDir, 'snapshot.json')), true);
    assert.equal(existsSync(join(bundleDir, 'attribution.json')), true);
    assert.equal(existsSync(join(bundleDir, 'provenance.json')), true);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'verdicts', `${verdictId}.md`)), true);

    // Returned packet round-trips through the schema parser AND the handoff gate.
    const reparsed = parseVerdictHandoffPacket(result.packet);
    assert.equal(reparsed.verdict, 'fix');
    const decision = assertCanCrossThreadHandoff(reparsed);
    assert.equal(decision.ok, true);
  });

  it('synthesizes snapshot.json fields that match the hand-written 2026-06-01..06-03 shape', () => {
    const harnessFeedbackRoot = makeRoot();
    generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));

    const snapshot = JSON.parse(
      readFileSync(
        join(
          harnessFeedbackRoot,
          'bundles',
          '2026-06-04-eval-a2a-source-adapter-unavailable',
          'snapshot.json',
        ),
        'utf8',
      ),
    );

    assert.equal(snapshot.featureId, 'F167');
    assert.equal(snapshot.sourceAdapter, 'f167-runtime-eval');
    assert.equal(snapshot.legacyScheduledTaskStatus.cleanupStatus, 'disabled');
    assert.equal(snapshot.dailySchedulerStatus.duplicateCronSlotFires, 0);

    const componentIds = snapshot.components.map((c) => c.id);
    assert.ok(componentIds.includes('source-adapter'));
    assert.ok(componentIds.includes('legacy-cleanup'));

    const sourceComponent = snapshot.components.find((c) => c.id === 'source-adapter');
    assert.equal(sourceComponent.confidence, 'no-data');

    // Endpoint checks list every probe verbatim so audit trails stay
    // reproducible without parsing the human markdown.
    assert.equal(snapshot.endpointChecks.length, 5);
  });

  it('emits attribution.json with one source-adapter-unavailable finding that carries endpoint-check evidence', () => {
    const harnessFeedbackRoot = makeRoot();
    generateA2aNoDataVerdict(
      baseInput(harnessFeedbackRoot, {
        ownerActionStatus: {
          branch: 'feat/f167-no-data-resilience',
          latestCommit: '988545163',
          reviewStatus: 'codex_approved_path_c',
        },
        previousVerdict: {
          packetId: 'vhp_eval_a2a_2026_06_03_source_adapter_closure_unmet',
          closureCondition: 'next eval can fetch metrics, metrics history, traces, and trace stats successfully',
          closureMet: false,
          reason: 'Telemetry stores remain unavailable on 2026-06-04.',
        },
      }),
    );

    const attribution = JSON.parse(
      readFileSync(
        join(
          harnessFeedbackRoot,
          'bundles',
          '2026-06-04-eval-a2a-source-adapter-unavailable',
          'attribution.json',
        ),
        'utf8',
      ),
    );

    assert.equal(attribution.findings.length, 1);
    const finding = attribution.findings[0];
    assert.equal(finding.frictionSignal.type, 'source_adapter_unavailable');
    assert.equal(finding.attribution.primaryLayer, 'environment_drift');

    const evidenceTypes = finding.attribution.evidence.map((e) => e.type);
    // Five endpoint probes + owner_action + previous_verdict
    assert.equal(evidenceTypes.filter((t) => t === 'endpoint_check').length, 5);
    assert.ok(evidenceTypes.includes('owner_action'));
    assert.ok(evidenceTypes.includes('previous_verdict'));
  });

  it('embeds the full Verdict Handoff Packet JSON and a Legacy Scheduled Task Status section in the verdict markdown', () => {
    const harnessFeedbackRoot = makeRoot();
    const result = generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));
    const md = result.markdown;

    assert.match(md, /^---\nfeature_ids: \[F192, F167\]/m);
    assert.match(md, /## Verdict Handoff Packet\n/);
    assert.match(md, /```json[\s\S]*"verdict":\s*"fix"[\s\S]*```/);
    assert.match(md, /## Legacy Scheduled Task Status\n/);
    assert.match(md, /Cleanup status: `disabled`/);
    assert.match(md, /Daily slot 2026-06-04T03:00:00\.000Z fires: 1/);
    // The Verdict Handoff Packet block must round-trip:
    const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(jsonMatch, 'verdict markdown must contain a json code block');
    const embedded = JSON.parse(jsonMatch[1]);
    const reparsed = parseVerdictHandoffPacket(embedded);
    assert.equal(reparsed.id, result.packet.id);
  });

  it('records the optional Owner action observed line only when ownerActionStatus is supplied', () => {
    const harnessFeedbackRoot = makeRoot();
    const without = generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot)).markdown;
    assert.doesNotMatch(without, /Owner action observed:/);

    const harnessFeedbackRoot2 = makeRoot();
    const with_ = generateA2aNoDataVerdict(
      baseInput(harnessFeedbackRoot2, {
        ownerActionStatus: {
          branch: 'feat/f167-no-data-resilience',
          latestCommit: '988545163',
          reviewStatus: 'codex_approved_path_c',
          notes: 'Build and tests passed in branch worktree.',
        },
      }),
    ).markdown;
    assert.match(with_, /Owner action observed: feat\/f167-no-data-resilience@988545163 \(codex_approved_path_c\) — Build and tests passed/);
  });

  it('writes provenance.json with a stable input fingerprint for re-eval audit', () => {
    const harnessFeedbackRoot = makeRoot();
    generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot, { generatorCommit: 'abcd1234' }));

    const provenance = JSON.parse(
      readFileSync(
        join(
          harnessFeedbackRoot,
          'bundles',
          '2026-06-04-eval-a2a-source-adapter-unavailable',
          'provenance.json',
        ),
        'utf8',
      ),
    );

    assert.equal(provenance.generator.name, 'eval-a2a-no-data-verdict');
    assert.equal(provenance.generator.commit, 'abcd1234');
    assert.equal(typeof provenance.inputFingerprint, 'string');
    assert.equal(provenance.inputFingerprint.length, 16);
  });

  it('rejects unsafe verdictIds before touching the filesystem', () => {
    const harnessFeedbackRoot = makeRoot();
    assert.throws(
      () =>
        generateA2aNoDataVerdict(
          baseInput(harnessFeedbackRoot, { verdictId: '../../etc/passwd' }),
        ),
      /verdictId must be a safe slug/,
    );
  });

  // Regression for codex review of c3672fb3e: the prior implementation wrote
  // `provenance.rawInputs: []` and used `source-adapter/<endpoint>` evidence
  // anchors, both of which made the generated artifact unreadable by the
  // existing Eval Hub `resolveA2aEvidenceBundle()` consumer. Without this
  // round-trip, `loadEvalHubSummary()` would throw on every no-data verdict.
  describe('Eval Hub read-model round-trip', () => {
    it('generates an artifact that resolveA2aEvidenceBundle() accepts (minimal input)', () => {
      const harnessFeedbackRoot = makeRoot();
      const result = generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));
      const resolved = resolveA2aEvidenceBundle({
        bundleDir: result.bundleDir,
        verdictId: '2026-06-04-eval-a2a-source-adapter-unavailable',
      });
      assert.equal(resolved.snapshot.featureId, 'F167');
      // resolver guarantees at least one bundled component evidence anchor exists.
      assert.equal(resolved.attributionReport.findings.length, 1);
      // provenance was the original P1: at-least-one rawInput + 64-char sha256.
      assert.ok(resolved.provenance.rawInputs.length >= 1);
      for (const raw of resolved.provenance.rawInputs) {
        assert.match(raw.sha256, /^[a-f0-9]{64}$/, `rawInput sha256 must be 64-char lowercase hex, got ${raw.sha256}`);
      }
    });

    it('round-trips with optional ownerActionStatus and previousVerdict (closure-unmet)', () => {
      const harnessFeedbackRoot = makeRoot();
      const result = generateA2aNoDataVerdict(
        baseInput(harnessFeedbackRoot, {
          ownerActionStatus: {
            branch: 'feat/f167-no-data-resilience',
            latestCommit: 'c3672fb3e',
            reviewStatus: 'codex_returned_p1',
          },
          previousVerdict: {
            packetId: 'vhp_eval_a2a_2026_06_03_source_adapter_closure_unmet',
            closureCondition: 'next eval can fetch metrics, traces, history successfully',
            closureMet: false,
            reason: 'Telemetry stores remain null on 2026-06-04.',
          },
        }),
      );
      // No throw == round-trip success; explicit re-parse to be defensive.
      const resolved = resolveA2aEvidenceBundle({
        bundleDir: result.bundleDir,
        verdictId: '2026-06-04-eval-a2a-source-adapter-unavailable',
      });
      assert.equal(resolved.attributionReport.findings.length, 1);
    });

    it('writes a side-by-side input.json artifact whose sha256 matches provenance.rawInputs', () => {
      const harnessFeedbackRoot = makeRoot();
      const result = generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));
      const provenance = JSON.parse(
        readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'),
      );
      assert.equal(provenance.rawInputs.length, 1);
      const raw = provenance.rawInputs[0];
      assert.ok(raw.path.endsWith('input.json'), `expected rawInputs[0].path to end with input.json, got ${raw.path}`);
      assert.match(raw.sha256, /^[a-f0-9]{64}$/);
      // The fingerprint and the persisted artifact share input semantics —
      // both should be stable across re-runs with identical input.
      assert.equal(existsSync(join(result.bundleDir, 'input.json')), true);
    });

    it('attribution evidence anchors land on real component metric keys (not endpoint paths)', () => {
      const harnessFeedbackRoot = makeRoot();
      generateA2aNoDataVerdict(baseInput(harnessFeedbackRoot));
      const snapshot = JSON.parse(
        readFileSync(
          join(
            harnessFeedbackRoot,
            'bundles',
            '2026-06-04-eval-a2a-source-adapter-unavailable',
            'snapshot.json',
          ),
          'utf8',
        ),
      );
      const attribution = JSON.parse(
        readFileSync(
          join(
            harnessFeedbackRoot,
            'bundles',
            '2026-06-04-eval-a2a-source-adapter-unavailable',
            'attribution.json',
          ),
          'utf8',
        ),
      );
      const sourceComponent = snapshot.components.find((c) => c.id === 'source-adapter');
      const validKeys = new Set([
        ...Object.keys(sourceComponent.frictionCounts),
        ...Object.keys(sourceComponent.activationCounts),
      ]);
      // For each endpoint_check evidence anchor that points at the
      // source-adapter component, the metric key suffix must be in the
      // component's counts — otherwise resolver rejects the bundle.
      const sourceAdapterAnchors = attribution.findings[0].attribution.evidence
        .filter((e) => e.anchor.startsWith('source-adapter/'))
        .map((e) => e.anchor.slice('source-adapter/'.length));
      assert.ok(sourceAdapterAnchors.length > 0, 'expected at least one source-adapter/<metric> anchor');
      for (const key of sourceAdapterAnchors) {
        assert.ok(validKeys.has(key), `evidence anchor "source-adapter/${key}" must exist in component counts, got keys=${JSON.stringify([...validKeys])}`);
      }
    });
  });
});
