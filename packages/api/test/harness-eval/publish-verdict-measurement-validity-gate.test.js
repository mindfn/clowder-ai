// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket } from './publish-verdict-fixtures.js';

describe('F267 measurement-validity publish gate', () => {
  it('blocks fix/build/delete_sunset before an active bundle has usable certified evidence', async (t) => {
    const repoRoot = mkdtempSync(`${tmpdir()}/f267-publish-gate-`);
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
    const harnessFeedbackRoot = resolve(repoRoot, 'docs/harness-feedback');
    mkdirSync(resolve(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
    writeFileSync(
      resolve(harnessFeedbackRoot, 'eval-domains/eval-a2a.yaml'),
      `domainId: eval:a2a
displayName: A2A Eval
systemThreadId: thread_eval_a2a
evalCat: { catId: codex, handle: "@codex", model: gpt-5.6-sol }
frequency: daily
sourceAdapter: a2a-snapshot
sourceRefsKind: a2a-snapshot-attribution
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis]
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F167, ownerCatId: opus-47, threadLookup: feature-thread }
sla: { acknowledgeHours: 24, reevalWithinHours: 48 }
metricGlossary:
  turn_custody.projections_total:
    label: Turn custody projections
    means: Total turn custody projections in the selected window.
    goodDirection: neutral
`,
    );
    let generatorCalled = false;
    const artifactPublisher = {
      async publishArtifact() {
        assert.fail('artifact publisher must not run through the F267 validity gate');
      },
    };

    for (const verdict of ['fix', 'build', 'delete_sunset']) {
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot,
          artifactPublisher,
          generator: async () => {
            generatorCalled = true;
            throw new Error('generator must not run through the F267 validity gate');
          },
        },
        {
          packet: buildPacket({
            id: `f267-block-${verdict.replace('_', '-')}`,
            verdict,
            governance: { cvoAcceptRequired: true },
            ownerAsk: {
              targetFeatureId: 'F167',
              targetOwnerCatId: 'opus-47',
              requestedAction: verdict,
            },
            evidencePacket: {
              snapshotRefs: ['snapshot:test'],
              attributionRefs: ['attribution:test'],
              metricRefs: ['metric:turn_custody.projections_total'],
              sampleTraceRefs: ['trace:test'],
            },
            dailyTrend: {
              window: '24h',
              current: { 'turn_custody.projections_total': 5 },
              baseline: { 'turn_custody.projections_total': 2 },
              threshold: { 'turn_custody.projections_total': 10 },
              direction: 'regressed',
            },
          }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );

      assert.ok('error' in result);
      assert.equal(result.status, 409);
      assert.equal(result.error, 'measurement_validity_gate');
      assert.match(result.detail, /keep_observe_only|certificate|insufficient|census missing/i);
    }
    assert.equal(generatorCalled, false);
  });
});
