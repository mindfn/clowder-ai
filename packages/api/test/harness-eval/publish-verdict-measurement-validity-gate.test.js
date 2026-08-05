// @ts-check

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket } from './publish-verdict-fixtures.js';

describe('F267 measurement-validity publish gate', () => {
  it('blocks fix/build/delete_sunset before an active bundle has usable certified evidence', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../../..');
    const harnessFeedbackRoot = resolve(repoRoot, 'docs/harness-feedback');
    let generatorCalled = false;

    for (const verdict of ['fix', 'build', 'delete_sunset']) {
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot,
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
