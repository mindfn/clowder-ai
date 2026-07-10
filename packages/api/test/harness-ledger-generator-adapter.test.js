/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter tests.
 *
 * KD-17 snapshot-first: adapter reads stored run snapshot by evalRunId
 * (no direct GuardRejectionEventLog query). Tests pre-write snapshot files.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { createHarnessLedgerGeneratorAdapter } = await import(
  '../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js'
);

// ── Test helpers ──

function makeTmpDir() {
  const dir = join(tmpdir(), `hlga-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePacket(overrides = {}) {
  return {
    id: `verdict-${Math.random().toString(36).slice(2, 10)}`,
    domainId: 'eval:harness-ledger',
    ...overrides,
  };
}

function makeSourceRefs(overrides = {}) {
  return {
    kind: 'prompt-segments',
    windowStartMs: Date.now() - 7 * 24 * 3600 * 1000,
    windowEndMs: Date.now(),
    evalRunId: 'test-run-default',
    ...overrides,
  };
}

function makeDeps(harnessFeedbackRoot) {
  return {
    harnessFeedbackRoot,
    liveHarnessFeedbackRoot: harnessFeedbackRoot,
  };
}

/** Write a stored run snapshot to the expected filesystem path. */
function writeRunSnapshot(rootDir, evalRunId, snapshotData = {}) {
  const dir = join(rootDir, 'run-snapshots');
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    evalRunId,
    producedAt: new Date().toISOString(),
    window: { startMs: Date.now() - 7 * 24 * 3600 * 1000, endMs: Date.now(), durationHours: 168 },
    totalEvents: 0,
    byKind: {},
    byGuard: {},
    sampleAnchors: [],
    howCounted: 'zset-window-scan',
    ...snapshotData,
  };
  writeFileSync(join(dir, `${evalRunId}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

describe('harness-ledger-generator-adapter', () => {
  test('throws on wrong sourceRefs kind', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () => generator(makePacket(), { kind: 'qc-metrics-rollup' }, makeDeps(makeTmpDir())),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_wrong_kind'));
        return true;
      },
    );
  });

  test('throws on invalid window (end <= start)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const now = Date.now();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          makeSourceRefs({ windowStartMs: now, windowEndMs: now - 1000 }),
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('invalid_window'));
        return true;
      },
    );
  });

  test('throws on non-finite window values', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          makeSourceRefs({ windowStartMs: Number.NaN, windowEndMs: Date.now() }),
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('invalid_window'));
        return true;
      },
    );
  });

  test('throws when evalRunId is missing (KD-17)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();

    await assert.rejects(
      () =>
        generator(
          makePacket(),
          { kind: 'prompt-segments', windowStartMs: Date.now() - 1000, windowEndMs: Date.now() },
          makeDeps(makeTmpDir()),
        ),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_missing_run_id'));
        return true;
      },
    );
  });

  test('throws when snapshot file is missing (fail-closed KD-17)', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();

    await assert.rejects(
      () => generator(makePacket(), makeSourceRefs({ evalRunId: 'nonexistent-run' }), makeDeps(tmpDir)),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_snapshot_missing'));
        return true;
      },
    );

    rmSync(tmpDir, { recursive: true });
  });

  test('produces zero-event verdict with noFindingRecord', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-zero-events';
    const packet = makePacket({ id: 'zero-events' });

    writeRunSnapshot(tmpDir, evalRunId, { totalEvents: 0, byKind: {}, byGuard: {} });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    assert.ok(result.verdictPath.endsWith('zero-events.md'));
    assert.ok(result.bundleDir.endsWith('zero-events'));

    // Verify files exist
    assert.ok(existsSync(result.verdictPath), 'verdict markdown exists');
    assert.ok(existsSync(join(result.bundleDir, 'snapshot.json')), 'snapshot.json exists');
    assert.ok(existsSync(join(result.bundleDir, 'attribution.json')), 'attribution.json exists');
    assert.ok(existsSync(join(result.bundleDir, 'provenance.json')), 'provenance.json exists');

    // Check snapshot
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 0);
    assert.equal(snapshot.featureId, 'F257');
    assert.equal(snapshot.components[0].confidence, 'no-data');

    // Check attribution has noFindingRecord
    const attr = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(attr.noFindingRecord, 'should have noFindingRecord for zero events');
    assert.equal(attr.findings.length, 0);

    // Check provenance has producedBy.runId (KD-17)
    const prov = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(prov.producedBy.runId, evalRunId);

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes('keep_observe'));
    assert.ok(md.includes('**Events**: 0'));

    rmSync(tmpDir, { recursive: true });
  });

  test('produces verdict with events from mixed kinds', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const now = Date.now();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-mixed-events';
    const packet = makePacket({ id: 'mixed-events' });

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 3,
      byKind: { http_rate_limit: 2, route_decision_block: 1 },
      byGuard: {
        hold_ball_rate_limit: { count: 2, kinds: ['http_rate_limit'] },
        a2a_block_pingpong: { count: 1, kinds: ['route_decision_block'] },
      },
    });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now, evalRunId }),
      makeDeps(tmpDir),
    );

    // Check snapshot
    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 3);
    assert.equal(snapshot.byKind.http_rate_limit, 2);
    assert.equal(snapshot.byKind.route_decision_block, 1);
    assert.equal(snapshot.byGuard.hold_ball_rate_limit, 2);
    assert.equal(snapshot.byGuard.a2a_block_pingpong, 1);
    assert.equal(snapshot.components[0].confidence, 'medium');

    // Check attribution has schema-compliant findings
    const attr = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(!attr.noFindingRecord, 'should NOT have noFindingRecord when events exist');
    assert.equal(attr.findings.length, 2); // 2 distinct guards

    const holdBallFinding = attr.findings.find((f) => f.id === 'f257-guard-hold_ball_rate_limit');
    assert.ok(holdBallFinding, 'finding for hold_ball_rate_limit exists');
    assert.equal(holdBallFinding.frictionSignal.severity, 'low'); // 2 events < 5
    assert.equal(holdBallFinding.frictionSignal.confidence, 0.7);
    assert.equal(holdBallFinding.frictionSignal.type, 'http_rate_limit');
    assert.equal(holdBallFinding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(holdBallFinding.attribution.evidence.length >= 1);
    assert.equal(holdBallFinding.attribution.evidence[0].anchor, 'guard-rejection-log/http_rate_limit');
    assert.equal(holdBallFinding.proposedAction[0].target, 'hold_ball_rate_limit');

    const pingpongFinding = attr.findings.find((f) => f.id === 'f257-guard-a2a_block_pingpong');
    assert.ok(pingpongFinding, 'finding for a2a_block_pingpong exists');
    assert.equal(pingpongFinding.frictionSignal.type, 'route_decision_block');
    assert.equal(pingpongFinding.attribution.evidence[0].anchor, 'guard-rejection-log/route_decision_block');

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('**Events**: 3'));
    assert.ok(md.includes('http_rate_limit'));
    assert.ok(md.includes('route_decision_block'));

    rmSync(tmpDir, { recursive: true });
  });

  test('guardId filter is passed through to snapshot', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const now = Date.now();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-filtered';
    const packet = makePacket({ id: 'filtered' });

    // Snapshot already filtered (provider would have filtered at query time)
    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 1,
      byKind: { http_rate_limit: 1 },
      byGuard: { target_guard: { count: 1, kinds: ['http_rate_limit'] } },
    });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now, evalRunId, guardId: 'target_guard' }),
      makeDeps(tmpDir),
    );

    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 1);
    assert.equal(snapshot.guardIdFilter, 'target_guard');
    assert.equal(snapshot.byGuard.target_guard, 1);
    assert.ok(!snapshot.byGuard.other_guard);

    rmSync(tmpDir, { recursive: true });
  });

  test('provenance contains sha256 of snapshot + producedBy.runId', async () => {
    const { createHash } = await import('node:crypto');
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-prov-check';
    const packet = makePacket({ id: 'prov-check' });

    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const snapshotJson = readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8');
    const expectedSha = createHash('sha256').update(snapshotJson).digest('hex');

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.rawInputs[0].sha256, expectedSha);
    assert.equal(provenance.generator.name, 'harness-ledger-generator-adapter');
    assert.equal(provenance.producedBy.runId, evalRunId);

    rmSync(tmpDir, { recursive: true });
  });

  test('verdict markdown uses packet fields when present', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-custom-verdict';
    const now = Date.now();

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 1,
      byKind: { http_rate_limit: 1 },
      byGuard: { hold_ball_rate_limit: { count: 1, kinds: ['http_rate_limit'] } },
    });

    const packet = makePacket({
      id: 'custom-verdict',
      verdict: 'regress',
      phenomenon: 'Guard rejections spiked after latest deploy',
      harnessUnderEval: { featureId: 'F257', componentId: 'guard-rejection-log', name: 'Harness Ledger v2' },
      ownerAsk: { requestedAction: 'Investigate spike in hold_ball rejections' },
      acceptanceReevalPlan: { nextEvalAt: '2026-07-17T00:00:00Z' },
    });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now, evalRunId }),
      makeDeps(tmpDir),
    );

    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('`regress`'), 'uses packet verdict');
    assert.ok(md.includes('Guard rejections spiked'), 'uses packet phenomenon');
    assert.ok(md.includes('Harness Ledger v2'), 'uses packet harnessUnderEval');
    assert.ok(md.includes('Investigate spike'), 'uses packet ownerAsk');
    assert.ok(md.includes('2026-07-17'), 'uses packet reevalPlan');

    rmSync(tmpDir, { recursive: true });
  });

  test('verdict YAML frontmatter includes all required Eval Hub fields', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-frontmatter';
    const packet = makePacket({ id: 'frontmatter-check' });

    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));
    const md = readFileSync(result.verdictPath, 'utf8');

    assert.ok(md.includes('feature_ids: [F257]'));
    assert.ok(md.includes('doc_kind: harness-feedback'));
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes('packet_id: frontmatter-check'));
    assert.ok(md.includes('source_snapshot:'));

    rmSync(tmpDir, { recursive: true });
  });

  test('bundle snapshot window matches selector', async () => {
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-window';
    const packet = makePacket({ id: 'window-check' });
    const start = 1700000000000;
    const end = 1700604800000; // ~7 days later

    writeRunSnapshot(tmpDir, evalRunId);

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: start, windowEndMs: end, evalRunId }),
      makeDeps(tmpDir),
    );

    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.window.startMs, start);
    assert.equal(snapshot.window.endMs, end);
    assert.equal(snapshot.window.durationHours, 168); // 7 days × 24h

    rmSync(tmpDir, { recursive: true });
  });

  // ── Resolver round-trip: bundles pass resolveA2aEvidenceBundle validation ──

  test('zero-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-rt-zero';
    const packet = makePacket({ id: 'roundtrip-zero' });

    writeRunSnapshot(tmpDir, evalRunId, { totalEvents: 0, byKind: {}, byGuard: {} });

    const result = await generator(packet, makeSourceRefs({ evalRunId }), makeDeps(tmpDir));

    const resolved = resolveA2aEvidenceBundle({ verdictId: packet.id, bundleDir: result.bundleDir });

    assert.equal(resolved.verdictId, packet.id);
    assert.ok(resolved.snapshot.featureId === 'F257');
    assert.equal(resolved.attributionReport.findings.length, 0);
    assert.ok(resolved.attributionReport.noFindingRecord);
    assert.equal(resolved.provenance.generator.name, 'harness-ledger-generator-adapter');

    rmSync(tmpDir, { recursive: true });
  });

  test('mixed-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = makeTmpDir();
    const evalRunId = 'test-rt-mixed';
    const now = Date.now();
    const packet = makePacket({ id: 'roundtrip-mixed' });

    writeRunSnapshot(tmpDir, evalRunId, {
      totalEvents: 3,
      byKind: { http_rate_limit: 2, route_decision_block: 1 },
      byGuard: {
        hold_ball_rate_limit: { count: 2, kinds: ['http_rate_limit'] },
        a2a_block_pingpong: { count: 1, kinds: ['route_decision_block'] },
      },
    });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now, evalRunId }),
      makeDeps(tmpDir),
    );

    const resolved = resolveA2aEvidenceBundle({ verdictId: packet.id, bundleDir: result.bundleDir });

    assert.equal(resolved.verdictId, packet.id);
    assert.ok(resolved.snapshot.featureId === 'F257');
    assert.ok(resolved.snapshot.window.durationHours >= 0);
    assert.ok(resolved.snapshot.components.length >= 1);
    assert.equal(resolved.attributionReport.findings.length, 2);
    assert.ok(!resolved.attributionReport.noFindingRecord);

    const finding = resolved.attributionReport.findings[0];
    assert.ok(finding.id.startsWith('f257-guard-'));
    assert.ok(['low', 'medium', 'high'].includes(finding.frictionSignal.severity));
    assert.equal(finding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(finding.attribution.evidence.length >= 1);
    assert.ok(finding.proposedAction.length >= 1);

    rmSync(tmpDir, { recursive: true });
  });
});
