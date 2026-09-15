/**
 * F257 local artifact store — shared fixtures for the publisher, integrity and
 * owner-scope suites. Kept out of the `.test.js` files so importing a helper never
 * registers another suite's tests.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const OWNER = 'owner-a';

export function makePacket(overrides = {}) {
  return {
    id: 'hlr-20260729-abcdef12',
    domainId: 'eval:harness-ledger',
    phenomenon: 'test phenomenon',
    harnessUnderEval: { featureId: 'F257', componentId: 'ledger', name: 'Harness Ledger' },
    verdict: 'keep_observe',
    ownerAsk: 'observe',
    dailyTrend: {},
    rootCauseHypothesis: 'test',
    evidencePacket: {},
    acceptanceReevalPlan: 'test',
    counterarguments: 'none',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The layout pinned independently of the implementation: owners/<sha256(owner)>/<domainSlug>/<artifactId>. */
export function expectedArtifactDir(artifactRoot, owner, domainSlug, artifactId) {
  const ownerKey = createHash('sha256').update(owner, 'utf8').digest('hex');
  return join(artifactRoot, 'owners', ownerKey, domainSlug, artifactId);
}

/** A generator that writes the canonical verdict and bundle, then returns their coordinates. */
export function writingGenerator(packet, extra = {}) {
  return async (outputRoot) => {
    const verdictPath = join(outputRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(outputRoot, 'bundles', packet.id);
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(dirname(verdictPath), { recursive: true });
    writeFileSync(verdictPath, extra.verdictBody ?? '# Verdict\n');
    writeFileSync(join(bundleDir, 'snapshot.json'), extra.snapshotBody ?? '{}');
    return { verdictPath, bundleDir, ...(extra.afterPublish ? { afterPublish: extra.afterPublish } : {}) };
  };
}

export function publishOpts(packet, generate, ownerUserId = OWNER) {
  return {
    packet,
    ownerUserId,
    sourceRefs: { kind: 'prompt-segments', windowStartMs: 1, windowEndMs: 2, evalRunId: packet.id },
    generate,
  };
}

export function makeHarnessLedgerDomainRegistry(harnessFeedbackRoot) {
  const dir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'eval-harness-ledger.yaml'),
    `---
domainId: eval:harness-ledger
displayName: Harness Ledger
systemThreadId: thread_eval_harness_ledger
evalCat:
  catId: codex
  handle: "@codex"
  model: gpt-5.6
frequency: daily
sourceAdapter: harness-ledger
sourceRefsKind: prompt-segments
enabled: true
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F257
  ownerCatId: codex
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
`,
  );
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A generator whose output the Eval Hub read model can render (verdict + snapshot/attribution/provenance). */
export function hubReadableGenerator(packet, { phenomenon = 'test' } = {}) {
  return async (outputRoot) => {
    const verdictId = packet.id;
    const evalSnapshotId = 'eval-F257-2026-07-29';
    const generatedAt = '2099-01-01T00:00:00.000Z';
    const verdictPath = join(outputRoot, 'verdicts', `${verdictId}.md`);
    const bundleDir = join(outputRoot, 'bundles', verdictId);
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(dirname(verdictPath), { recursive: true });
    writeFileSync(
      verdictPath,
      `---
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: ${packet.domainId}
packet_id: ${verdictId}
---

# Verdict

- Verdict: \`keep_observe\`
- Phenomenon: ${phenomenon}
- Owner ask: observe
- Harness: F257/ledger (Harness Ledger)
- Re-eval: ${generatedAt}

Evidence:
- metric:test
`,
    );
    writeJson(join(bundleDir, 'snapshot.json'), {
      verdictId,
      evalSnapshotId,
      featureId: 'F257',
      generatedAt,
      window: { startMs: 1, endMs: 2, durationHours: 0 },
      components: [
        {
          componentId: 'C1',
          componentName: 'test component',
          confidence: 'medium',
          activationCounts: { 'test.metric': 1 },
          frictionCounts: {},
        },
      ],
    });
    writeJson(join(bundleDir, 'attribution.json'), {
      verdictId,
      featureId: 'F257',
      evalSnapshotId,
      generatedAt,
      findings: [],
      noFindingRecord: { reason: 'fixture', evidence: 'fixture' },
    });
    writeJson(join(bundleDir, 'provenance.json'), {
      verdictId,
      generatedAt,
      rawInputs: [{ path: 'test-input', sha256: '0'.repeat(64) }],
      generator: { name: 'test', version: '1.0.0' },
      sanitizeRulesVersion: '1.0.0',
    });
    return { verdictPath, bundleDir };
  };
}
