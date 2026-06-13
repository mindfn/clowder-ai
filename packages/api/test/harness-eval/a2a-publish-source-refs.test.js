import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { writeA2aPublishSourceRefs } from '../../dist/infrastructure/harness-eval/a2a/a2a-publish-source-refs.js';
import { generateA2aLiveVerdict } from '../../dist/infrastructure/harness-eval/a2a/eval-a2a-live-verdict.js';

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
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
  fixtures: [],
};

describe('eval:a2a publish sourceRefs producer', () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('writes basename raw YAMLs that the a2a live verdict generator can consume', () => {
    const root = mkdtempSync(join(tmpdir(), 'a2a-publish-refs-'));
    roots.push(root);
    const generatedAt = '2026-06-12T03:00:00.000Z';
    const refs = writeA2aPublishSourceRefs({
      harnessFeedbackRoot: root,
      generatedAt,
      traces: { spans: [], count: 0 },
      metrics: {
        cat_cafe_a2a_c2_verdict_hint_emitted: 10,
        cat_cafe_a2a_c2_verdict_without_pass_count: 4,
      },
      metricsHistory: { snapshots: [], count: 0 },
      traceStats: {
        spanCount: 0,
        maxSpans: 10000,
        maxAgeMs: 86400000,
        oldestStoredAt: Date.parse(generatedAt) - 3600000,
        newestStoredAt: Date.parse(generatedAt),
      },
    });

    assert.equal(refs.kind, 'a2a-snapshot-attribution');
    assert.equal(refs.snapshotName, '2026-06-12T03-00-00-000Z-F167-eval.yaml');
    assert.equal(refs.attributionName, '2026-06-12T03-00-00-000Z-F167-attribution.yaml');
    assert.equal(existsSync(refs.snapshotPath), true);
    assert.equal(existsSync(refs.attributionPath), true);
    assert.match(readFileSync(refs.snapshotPath, 'utf8'), /eval_snapshot_id: eval-F167-2026-06-12/);
    assert.match(readFileSync(refs.attributionPath, 'utf8'), /eval_snapshot_id: eval-F167-2026-06-12/);

    const artifact = generateA2aLiveVerdict({
      verdictId: '2026-06-12-a2a-producer-test',
      rawSnapshotPath: refs.snapshotPath,
      rawAttributionPath: refs.attributionPath,
      harnessFeedbackRoot: root,
      domain,
    });

    assert.equal(artifact.packet.domainId, 'eval:a2a');
    assert.match(artifact.packet.evidencePacket.snapshotRefs[0], /snapshot:bundle\/2026-06-12-a2a-producer-test/);
  });
});
