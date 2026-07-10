/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter tests.
 *
 * Verifies the adapter correctly converts GuardRejectionEventLog data
 * into verdict + bundle artifacts following the standard eval domain pattern.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { createHarnessLedgerGeneratorAdapter } = await import(
  '../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js'
);

// ── Fake GuardRejectionEventLog ──

class FakeGuardRejectionEventLog {
  constructor(events = []) {
    this._events = events;
  }

  async queryWindow(opts) {
    let result = this._events.filter((e) => e.timestamp >= opts.since && e.timestamp < (opts.until ?? Infinity));
    if (opts.guardId) result = result.filter((e) => e.guardId === opts.guardId);
    if (opts.threadId) result = result.filter((e) => e.threadId === opts.threadId);
    if (opts.catId) result = result.filter((e) => e.catId === opts.catId);
    return result.slice(0, opts.limit ?? 200);
  }

  // Strict variant — same logic, used by adapter (fail-closed eval path)
  async queryWindowStrict(opts) {
    return this.queryWindow(opts);
  }
}

/** Fake that throws on any query — simulates Redis outage for fail-closed test. */
class ThrowingGuardRejectionEventLog {
  async queryWindow() {
    throw new Error('REDIS_CONNECTION_REFUSED');
  }

  async queryWindowStrict() {
    throw new Error('REDIS_CONNECTION_REFUSED');
  }
}

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
    ...overrides,
  };
}

function makeDeps(harnessFeedbackRoot) {
  return {
    harnessFeedbackRoot,
    liveHarnessFeedbackRoot: harnessFeedbackRoot,
  };
}

function makeEvent(overrides = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'http_rate_limit',
    threadId: 'thread-1',
    catId: 'cat-1',
    guardId: 'hold_ball_rate_limit',
    timestamp: Date.now() - 3600000,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 3,
    windowMs: 60000,
    ...overrides,
  };
}

function makeBlockEvent(overrides = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'route_decision_block',
    threadId: 'thread-2',
    catId: 'cat-2',
    guardId: 'a2a_block_pingpong',
    timestamp: Date.now() - 1800000,
    correlationConfidence: 'window',
    fromCatId: 'cat-2',
    targetCatId: 'cat-3',
    streakCount: 4,
    ...overrides,
  };
}

describe('harness-ledger-generator-adapter', () => {
  test('throws on wrong sourceRefs kind', async () => {
    const log = new FakeGuardRejectionEventLog();
    const generator = createHarnessLedgerGeneratorAdapter(log);

    await assert.rejects(
      () => generator(makePacket(), { kind: 'qc-metrics-rollup' }, makeDeps(makeTmpDir())),
      (err) => {
        assert.ok(err.message.includes('harness_ledger_adapter_wrong_kind'));
        return true;
      },
    );
  });

  test('throws on invalid window (end <= start)', async () => {
    const log = new FakeGuardRejectionEventLog();
    const generator = createHarnessLedgerGeneratorAdapter(log);
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
    const log = new FakeGuardRejectionEventLog();
    const generator = createHarnessLedgerGeneratorAdapter(log);

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

  test('produces zero-event verdict with noFindingRecord', async () => {
    const log = new FakeGuardRejectionEventLog([]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'zero-events' });

    const result = await generator(packet, makeSourceRefs(), makeDeps(tmpDir));

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

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes('keep_observe'));
    assert.ok(md.includes('**Events**: 0'));

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('produces verdict with events from mixed kinds', async () => {
    const now = Date.now();
    const events = [
      makeEvent({ timestamp: now - 5000 }),
      makeEvent({ timestamp: now - 4000 }),
      makeBlockEvent({ timestamp: now - 3000 }),
    ];
    const log = new FakeGuardRejectionEventLog(events);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'mixed-events' });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now }),
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

    // Check attribution has schema-compliant findings (not noFindingRecord)
    const attr = JSON.parse(readFileSync(join(result.bundleDir, 'attribution.json'), 'utf8'));
    assert.ok(!attr.noFindingRecord, 'should NOT have noFindingRecord when events exist');
    assert.equal(attr.findings.length, 2); // 2 distinct guards

    // Verify attributionFindingSchema compliance (id, frictionSignal, attribution, proposedAction)
    const holdBallFinding = attr.findings.find((f) => f.id === 'f257-guard-hold_ball_rate_limit');
    assert.ok(holdBallFinding, 'finding for hold_ball_rate_limit exists');
    assert.equal(holdBallFinding.frictionSignal.severity, 'low'); // 2 events < 5
    assert.equal(holdBallFinding.frictionSignal.confidence, 0.7);
    assert.equal(holdBallFinding.frictionSignal.type, 'http_rate_limit');
    assert.equal(holdBallFinding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(holdBallFinding.attribution.evidence.length >= 1);
    assert.equal(holdBallFinding.attribution.evidence[0].anchor, 'guard-rejection-log/http_rate_limit');
    assert.equal(holdBallFinding.proposedAction[0].target, 'hold_ball_rate_limit');
    assert.ok(holdBallFinding.proposedAction[0].rationale.includes('2'));

    const pingpongFinding = attr.findings.find((f) => f.id === 'f257-guard-a2a_block_pingpong');
    assert.ok(pingpongFinding, 'finding for a2a_block_pingpong exists');
    assert.equal(pingpongFinding.frictionSignal.type, 'route_decision_block');
    assert.equal(pingpongFinding.attribution.evidence[0].anchor, 'guard-rejection-log/route_decision_block');

    // Check verdict markdown
    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('**Events**: 3'));
    assert.ok(md.includes('http_rate_limit'));
    assert.ok(md.includes('route_decision_block'));

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('guardId filter is passed through to queryWindow', async () => {
    const now = Date.now();
    const events = [
      makeEvent({ timestamp: now - 5000, guardId: 'target_guard' }),
      makeEvent({ timestamp: now - 4000, guardId: 'other_guard' }),
    ];
    const log = new FakeGuardRejectionEventLog(events);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'filtered' });

    const result = await generator(
      packet,
      makeSourceRefs({
        windowStartMs: now - 10000,
        windowEndMs: now,
        guardId: 'target_guard',
      }),
      makeDeps(tmpDir),
    );

    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.totalEvents, 1);
    assert.equal(snapshot.guardIdFilter, 'target_guard');
    assert.equal(snapshot.byGuard.target_guard, 1);
    assert.ok(!snapshot.byGuard.other_guard);

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('provenance contains sha256 of snapshot', async () => {
    const { createHash } = await import('node:crypto');
    const log = new FakeGuardRejectionEventLog([]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'prov-check' });

    const result = await generator(packet, makeSourceRefs(), makeDeps(tmpDir));

    const snapshotJson = readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8');
    const expectedSha = createHash('sha256').update(snapshotJson).digest('hex');

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.rawInputs[0].sha256, expectedSha);
    assert.equal(provenance.generator.name, 'harness-ledger-generator-adapter');

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('verdict markdown uses packet fields when present', async () => {
    const log = new FakeGuardRejectionEventLog([makeEvent({ timestamp: Date.now() - 1000 })]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const packet = makePacket({
      id: 'custom-verdict',
      verdict: 'regress',
      phenomenon: 'Guard rejections spiked after latest deploy',
      harnessUnderEval: {
        featureId: 'F257',
        componentId: 'guard-rejection-log',
        name: 'Harness Ledger v2',
      },
      ownerAsk: { requestedAction: 'Investigate spike in hold_ball rejections' },
      acceptanceReevalPlan: { nextEvalAt: '2026-07-17T00:00:00Z' },
    });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now }),
      makeDeps(tmpDir),
    );

    const md = readFileSync(result.verdictPath, 'utf8');
    assert.ok(md.includes('`regress`'), 'uses packet verdict');
    assert.ok(md.includes('Guard rejections spiked'), 'uses packet phenomenon');
    assert.ok(md.includes('Harness Ledger v2'), 'uses packet harnessUnderEval');
    assert.ok(md.includes('Investigate spike'), 'uses packet ownerAsk');
    assert.ok(md.includes('2026-07-17'), 'uses packet reevalPlan');

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('verdict YAML frontmatter includes all required Eval Hub fields', async () => {
    const log = new FakeGuardRejectionEventLog([]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'frontmatter-check' });

    const result = await generator(packet, makeSourceRefs(), makeDeps(tmpDir));
    const md = readFileSync(result.verdictPath, 'utf8');

    // Check required YAML frontmatter fields for Eval Hub compatibility
    assert.ok(md.includes('feature_ids: [F257]'));
    assert.ok(md.includes('doc_kind: harness-feedback'));
    assert.ok(md.includes('feedback_type: live-verdict'));
    assert.ok(md.includes('domain_id: eval:harness-ledger'));
    assert.ok(md.includes(`packet_id: frontmatter-check`));
    assert.ok(md.includes('source_snapshot:'));

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('bundle snapshot window matches selector', async () => {
    const log = new FakeGuardRejectionEventLog([]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'window-check' });
    const start = 1700000000000;
    const end = 1700604800000; // ~7 days later

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: start, windowEndMs: end }),
      makeDeps(tmpDir),
    );

    const snapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.window.startMs, start);
    assert.equal(snapshot.window.endMs, end);
    assert.equal(snapshot.window.durationHours, 168); // 7 days × 24h

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  // ── P1 regression: Redis fail-closed (queryWindowStrict) ──

  test('ThrowingRedis → adapter rejects instead of writing false zero-event verdict', async () => {
    const log = new ThrowingGuardRejectionEventLog();
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();

    await assert.rejects(
      () => generator(makePacket(), makeSourceRefs(), makeDeps(tmpDir)),
      (err) => {
        assert.ok(err.message.includes('REDIS_CONNECTION_REFUSED'));
        return true;
      },
    );

    // Must NOT have written any verdict or bundle (fail-closed)
    assert.ok(!existsSync(join(tmpDir, 'verdicts')), 'no verdict dir should exist on Redis error');

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  // ── Resolver round-trip: bundles pass resolveA2aEvidenceBundle validation ──

  test('zero-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const log = new FakeGuardRejectionEventLog([]);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'roundtrip-zero' });

    const result = await generator(packet, makeSourceRefs(), makeDeps(tmpDir));

    // resolveA2aEvidenceBundle validates snapshot/attribution/provenance schemas
    const resolved = resolveA2aEvidenceBundle({
      verdictId: packet.id,
      bundleDir: result.bundleDir,
    });

    assert.equal(resolved.verdictId, packet.id);
    assert.ok(resolved.snapshot.featureId === 'F257');
    assert.equal(resolved.attributionReport.findings.length, 0);
    assert.ok(resolved.attributionReport.noFindingRecord);
    assert.equal(resolved.provenance.generator.name, 'harness-ledger-generator-adapter');

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  test('mixed-events bundle passes resolveA2aEvidenceBundle round-trip', async () => {
    const { resolveA2aEvidenceBundle } = await import(
      '../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js'
    );
    const now = Date.now();
    const events = [
      makeEvent({ timestamp: now - 5000 }),
      makeEvent({ timestamp: now - 4000 }),
      makeBlockEvent({ timestamp: now - 3000 }),
    ];
    const log = new FakeGuardRejectionEventLog(events);
    const generator = createHarnessLedgerGeneratorAdapter(log);
    const tmpDir = makeTmpDir();
    const packet = makePacket({ id: 'roundtrip-mixed' });

    const result = await generator(
      packet,
      makeSourceRefs({ windowStartMs: now - 10000, windowEndMs: now }),
      makeDeps(tmpDir),
    );

    // resolveA2aEvidenceBundle validates ALL schemas + cross-references:
    // - bundleSnapshotSchema (window.durationHours, components)
    // - bundleAttributionSchema (findings with attributionFindingSchema)
    // - bundleProvenanceSchema (sha256 digest)
    // - assertAttributionAnchors (evidence anchors match snapshot metrics)
    const resolved = resolveA2aEvidenceBundle({
      verdictId: packet.id,
      bundleDir: result.bundleDir,
    });

    assert.equal(resolved.verdictId, packet.id);
    // Note: totalEvents/byKind/byGuard are adapter-extra fields not in
    // bundleSnapshotSchema — Zod strips them. Schema-validated fields:
    assert.equal(resolved.snapshot.featureId, 'F257');
    assert.ok(resolved.snapshot.window.durationHours >= 0);
    assert.ok(resolved.snapshot.components.length >= 1);
    assert.equal(resolved.attributionReport.findings.length, 2);
    assert.ok(!resolved.attributionReport.noFindingRecord);

    // Verify findings survived schema + anchor validation
    const finding = resolved.attributionReport.findings[0];
    assert.ok(finding.id.startsWith('f257-guard-'));
    assert.ok(['low', 'medium', 'high'].includes(finding.frictionSignal.severity));
    assert.equal(finding.attribution.primaryLayer, 'guard-rejection-log');
    assert.ok(finding.attribution.evidence.length >= 1);
    assert.ok(finding.proposedAction.length >= 1);

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });
});
