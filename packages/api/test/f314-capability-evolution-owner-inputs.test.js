import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { parse } from 'yaml';

const PROGRAM_ID = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
const ROOT = resolve(import.meta.dirname, '../../..');
const INPUT_ROOT = resolve(ROOT, 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs');
const PREFIX = 'evolution-program-ba0f4524e49cc879279164d5b272cf8c';
const SOURCE_ARTIFACT_REF = `docs/harness-feedback/measurement-sources/capability-evolution/${PREFIX}.yaml`;
const SOURCE_REF = resolve(ROOT, SOURCE_ARTIFACT_REF);
const V1_MANIFEST_REVISION = 'faff26de30a5603be00ad4de1a0b07af365f1d8d';
const V2_MANIFEST_REVISION = '85803beb4530b48127c2afcbb41282124e0de9f9';
const CURRENT_SOURCE_REVISION = 'bc4949175f5dde152a430599d3e121c7c2458e20';
const V2_INPUT_REVISION = '44a0b9805cd3d2e059c5733a0bd020a3cd69df71';
const V1_CENSUS_REVISION = 'da83ee28757113c9ef3f20ccd98b7d2486b1d1b1';
const exec = promisify(execFile);

const TARGET_REF = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
const CONSUMER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' };
const NAMED_CONSUMER_REF = { ownerFeatureId: 'F100', ownerStateRef: 'cat:opus' };
const V3_NAMED_CONSUMER_REF = { ownerFeatureId: 'F100', ownerStateRef: 'cat:opus55' };
const OBSERVER_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:codex-sol' };
const DOMAIN_OWNER_REF = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability-owner:development-process-harness-effectiveness',
};
const CALIBRATOR_REF = { ownerFeatureId: 'F267', ownerStateRef: 'cat:kimi' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readInput(suffix) {
  return parse(await readFile(resolve(INPUT_ROOT, `${PREFIX}-${suffix}.yaml`), 'utf8'));
}

describe('F314 capability-evolution owner inputs', () => {
  it('starts treatment only when the accepted-source anchor shipped in PR #4268', async () => {
    const census = await readInput('observation-census-v1');

    assert.equal(census.window.endMs, 1788426565000);
    assert.match(census.window.selection, /accepted-source anchor PR #4268 merge/);
    assert.match(census.window.boundaryPointDisposition, /treatment-start event/);
    assert.match(census.window.boundaryPointDisposition, /not a baseline outcome/);
    assert.ok(census.candidateArtifacts.every((artifact) => artifact.disposition !== 'eligible_observation'));
  });

  it('derives both comparison arms from typed verdict freshness inside one durable-review channel', async () => {
    const [goal, procedure, census] = await Promise.all([
      readInput('goal-certificate-v1'),
      readInput('measurement-procedure-v1'),
      readInput('observation-census-v1'),
    ]);

    assert.equal(procedure.comparisonDesign.design, 'within_channel_first_verdict_freshness_contrast');
    assert.equal(procedure.comparisonDesign.effectScale, 'current_first_verdict_minus_stale_then_current');
    assert.equal(procedure.comparisonDesign.assignment, 'natural_source_movement_only');
    assert.equal(procedure.comparisonDesign.heldConstant, 'local_durable_review');
    assert.deepEqual(procedure.comparisonDesign.exactMatchKeys, [
      'project',
      'risk_route',
      'calendar_week',
      'review_channel',
    ]);
    assert.match(procedure.comparisonDesign.baselineDisposition, /optimizer-exposed context/i);
    assert.match(goal.successBoundary.join(' '), /current first verdict versus stale-then-current/i);
    assert.equal(census.referenceFrame.type, 'within_local_durable_review_first_verdict_freshness');
    assert.equal(census.referenceFrame.effectScale, 'current_first_verdict_minus_stale_then_current');
    assert.match(census.referenceFrame.channelBoundary, /external GitHub.*not controls/i);
    assert.match(procedure.comparisonDesign.noControlRule, /insufficient/i);

    const armDefinitions = [
      procedure.comparisonDesign.currentAtFirstVerdictArm,
      procedure.comparisonDesign.staleThenCurrentArm,
    ].join(' ');
    assert.match(armDefinitions, /first non-author typed local-review verdict/i);
    assert.match(armDefinitions, /acceptedRevision/i);
    assert.match(armDefinitions, /reviewedHeadSha/i);
    assert.doesNotMatch(armDefinitions, /request artifact|request carried|request lacked/i);
  });

  it('names every arm, join, and eligibility carrier and freezes the episode fact lifecycle', async () => {
    const [procedure, census] = await Promise.all([
      readInput('measurement-procedure-v1'),
      readInput('observation-census-v1'),
    ]);

    assert.match(procedure.typedCarrierContract.invariant, /must name an exact typed carrier/i);
    assert.match(procedure.typedCarrierContract.proseBoundary, /must not define an arm, join, or denominator/i);
    assert.deepEqual(
      procedure.typedCarrierContract.invariants.map((invariant) => invariant.id),
      ['INV-1', 'INV-2', 'INV-3', 'INV-4'],
    );
    assert.deepEqual(procedure.typedCarrierContract.armCarriers, [
      'StoredMessage.id',
      'StoredMessage.threadId',
      'StoredMessage.timestamp',
      'StoredMessage.catId',
      'StoredMessage.extra.localReviewVerdict.reviewSubjectRef',
      'StoredMessage.extra.localReviewVerdict.acceptedSourceRef',
      'StoredMessage.extra.localReviewVerdict.acceptedRevision',
      'StoredMessage.extra.localReviewVerdict.reviewedHeadSha',
      'StoredMessage.extra.localReviewVerdict.verdict',
    ]);

    const episode = procedure.episodeFactLifecycle.objects.find(
      (object) => object.id === 'durable_local_review_episode',
    );
    assert.ok(episode);
    assert.equal(episode.lifecycleOwner, 'F267 measurement owner');
    assert.match(episode.identity, /stable reviewSubjectRef.*acceptedSourceRef/i);
    assert.deepEqual(
      episode.transitions.map((transition) => transition.id),
      [
        'first_typed_verdict',
        'classify_current_first_verdict',
        'classify_stale_first_verdict',
        'observe_later_current_verdict',
        'complete_owner_joins',
        'invalidate_missing_or_drifted_carrier',
      ],
    );
    assert.match(
      procedure.episodeFactLifecycle.pureProjections.sourceRevisionAtVerdict,
      /git log -1.*reviewedHeadSha/i,
    );
    assert.match(procedure.episodeFactLifecycle.pureProjections.armLabel, /not stored independently/i);
    assert.deepEqual(
      procedure.episodeFactLifecycle.objects.map((object) => object.id),
      ['durable_local_review_episode', 'program_observation_join', 'frozen_measurement_cohort'],
    );
    assert.deepEqual(
      procedure.episodeFactLifecycle.adversarialScenarios.map((scenario) => scenario.id),
      [
        'crash_after_stale_first_verdict',
        'concurrent_verdict_delivery',
        'restored_or_truncated_history',
        'bypass_request_prose_or_external_review',
        'subject_identity_changes_between_rounds',
      ],
    );
    assert.deepEqual(
      procedure.episodeFactLifecycle.testMatrix.map((entry) => entry.invariant),
      ['INV-1', 'INV-2', 'INV-3', 'INV-4'],
    );
    assert.match(census.eligibility.typedCarrierRule, /prose-only evidence is insufficient/i);
  });

  it('predeclares decision boundaries, action vocabulary, and a separate time-fresh holdout', async () => {
    const [procedure, assignment] = await Promise.all([
      readInput('measurement-procedure-v1'),
      readInput('measurement-role-assignment-v1'),
    ]);

    assert.deepEqual(procedure.actionVocabulary, {
      keep: 'keep_observe',
      tune: 'fix',
      sunset: 'delete_sunset',
      insufficient: 'keep_observe',
    });
    assert.equal(procedure.decisionRules.intervalLevel, 0.95);
    assert.match(procedure.decisionRules.primaryImproved, /upper bound.*below zero/i);
    assert.match(procedure.decisionRules.guardrailWorsened, /lower bound.*above zero/i);
    assert.match(procedure.holdout.promotionHoldout, /next complete calendar-week matched block/i);
    assert.match(procedure.holdout.promotionHoldout, /excluded from the analysis cohort/i);
    assert.equal(assignment.certificateDecision.consumerFeatureId, 'F311');
    assert.equal(assignment.certificateDecision.consumerOwnerCatId, 'opus');
  });

  it('versions the named measurement consumer without rewriting the value-owner-backed v1 chain', async () => {
    const [legacyProcedure, legacyAssignment, procedure, assignment] = await Promise.all([
      readInput('measurement-procedure-v1'),
      readInput('measurement-role-assignment-v1'),
      readInput('measurement-procedure-v2'),
      readInput('measurement-role-assignment-v2'),
    ]);

    assert.deepEqual(legacyProcedure.consumerRef, CONSUMER_REF);
    assert.deepEqual(legacyAssignment.roles.consumer, CONSUMER_REF);
    assert.deepEqual(procedure.consumerRef, NAMED_CONSUMER_REF);
    assert.deepEqual(assignment.roles.consumer, NAMED_CONSUMER_REF);
    assert.equal(assignment.certificateDecision.consumerFeatureId, 'F100');
    assert.equal(assignment.certificateDecision.consumerOwnerCatId, 'opus');
    assert.match(assignment.roleRationale.consumer, /value owner.*F311\/user:default-user/i);
    assert.match(assignment.roleRationale.consumer, /named.*F100\/cat:opus/i);
    assert.match(procedure.truthBoundary.join(' '), /value.*authority.*F311\/user:default-user/i);
    assert.match(procedure.truthBoundary.join(' '), /named.*consumer.*F100\/cat:opus/i);
  });

  it('keeps v1/v2 replayable while v3 transfers only the named measurement consumer', async () => {
    const [v2ProcedureBytes, v2AssignmentBytes, procedure, assignment] = await Promise.all([
      readFile(resolve(INPUT_ROOT, `${PREFIX}-measurement-procedure-v2.yaml`), 'utf8'),
      readFile(resolve(INPUT_ROOT, `${PREFIX}-measurement-role-assignment-v2.yaml`), 'utf8'),
      readInput('measurement-procedure-v3'),
      readInput('measurement-role-assignment-v3'),
    ]);
    const [{ stdout: publishedProcedure }, { stdout: publishedAssignment }] = await Promise.all([
      exec('git', [
        '-C',
        ROOT,
        'show',
        `${V2_INPUT_REVISION}:docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/${PREFIX}-measurement-procedure-v2.yaml`,
      ]),
      exec('git', [
        '-C',
        ROOT,
        'show',
        `${V2_INPUT_REVISION}:docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/${PREFIX}-measurement-role-assignment-v2.yaml`,
      ]),
    ]);

    assert.equal(v2ProcedureBytes, publishedProcedure);
    assert.equal(v2AssignmentBytes, publishedAssignment);
    assert.deepEqual(procedure.consumerRef, V3_NAMED_CONSUMER_REF);
    assert.match(procedure.population.inclusion[0], /PR #4268.*exact loaded version/i);
    assert.match(procedure.window.selection, /after PR #4268 is loaded/i);
    assert.match(procedure.window.currentBoundaryStatus, /loadedAt is unresolved/i);
    assert.deepEqual(assignment.roles.consumer, V3_NAMED_CONSUMER_REF);
    assert.equal(assignment.certificateDecision.consumerFeatureId, 'F100');
    assert.equal(assignment.certificateDecision.consumerOwnerCatId, 'opus55');
    assert.equal(assignment.calibratorAcceptanceRef, 'thread_mrqepow7eugwx5jr#0001791044038119-001041-5332829f');
    assert.ok(assignment.assignmentSourceRefs.includes('thread_mrqepow7eugwx5jr#0001791043893159-001012-abf75f3f'));
    for (const retainedSourceRef of [
      'thread_ms9gw96ssk7lm13j#0001788492920380-000230-26dc1b03',
      'thread_mtlkkh5yywn6e7vh#0001788493585805-000260-87060e00',
      'thread_mtlkkh5yywn6e7vh#0001788493287632-000251-ff7c63d6',
    ]) {
      assert.ok(assignment.assignmentSourceRefs.includes(retainedSourceRef), retainedSourceRef);
    }
    assert.match(assignment.roleRationale.consumer, /F100\/cat:opus55/i);
    assert.match(assignment.roleRationale.consumer, /value owner.*F311\/user:default-user/i);
    assert.match(assignment.truthBoundary.join(' '), /v1.*v2.*unchanged/i);
    assert.match(procedure.truthBoundary.join(' '), /v2.*YAML.*truncated.*#4268.*v3.*full text/i);
    assert.deepEqual(assignment.roles.observer, OBSERVER_REF);
    assert.deepEqual(assignment.roles.domainOwner, DOMAIN_OWNER_REF);
    assert.deepEqual(assignment.roles.calibrator, CALIBRATOR_REF);
  });

  it('freezes reopenable F100 version evidence without inventing loadedAt or a usable window', async () => {
    const [legacyBytes, census] = await Promise.all([
      readFile(resolve(INPUT_ROOT, `${PREFIX}-observation-census-v1.yaml`), 'utf8'),
      readInput('observation-census-v2'),
    ]);
    const { stdout: publishedLegacy } = await exec('git', [
      '-C',
      ROOT,
      'show',
      `${V1_CENSUS_REVISION}:docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/${PREFIX}-observation-census-v1.yaml`,
    ]);

    assert.equal(legacyBytes, publishedLegacy);
    assert.deepEqual(census.valueOwnerRef, CONSUMER_REF);
    assert.deepEqual(census.consumerRef, V3_NAMED_CONSUMER_REF);
    assert.match(census.measurementProcedureRef, /measurement-procedure-v3\.yaml$/u);
    assert.equal(census.ownerVersionRead.readAt, '2026-10-03T16:36:41.212Z');
    assert.equal(
      census.ownerVersionRead.currentVersionRef.version,
      '3084ef09530e019d14bdf7e81043bbae6f4ab66b51b019005c42adb18d963285',
    );
    assert.equal(
      census.ownerVersionRead.currentProofRef.ownerStateRef,
      'git-blob:4721d9edb733aa8ba5577060aa3911cc9d7a9fc1:4d3f9c7ddc5ee592667990684c6b7884179efb9c',
    );
    assert.deepEqual(census.ownerVersionRead.currentBlockers, [
      'adoption_proof_unavailable',
      'applied_use_proof_unavailable',
    ]);
    assert.equal(
      census.historicalUseProjection.versionRef.version,
      '79acf4d7b43d4c95c5120c1dece9c19355950f5bae8b3d68880c4e91d26b7ef0',
    );
    assert.deepEqual(census.historicalUseProjection.counts, { total: 127, applied: 125, dismissed: 2 });
    assert.equal(
      census.historicalUseProjection.firstUse.receiptRef.ownerStateRef,
      'request-review-use:5e9dec0f49b9fd6554bd4d7528aee5d55b9043ef5fbaad8b74dd7c96fc01c755:0001789313657536-000076-3ea7c5a8',
    );
    assert.equal(census.historicalUseProjection.firstUse.occurredAt, '2026-09-13T15:34:38.899Z');
    assert.equal(
      census.historicalUseProjection.lastUse.receiptRef.ownerStateRef,
      'request-review-use:3f4e10472935d48690bed05e18b254cbd33b0944da40926f61cf8d6775859da7:0001790166363355-000367-e133e743',
    );
    assert.equal(census.historicalUseProjection.lastUse.occurredAt, '2026-09-23T12:26:09.294Z');
    assert.equal(census.exposureBoundary.status, 'unresolved');
    assert.equal(census.exposureBoundary.loadedAt, null);
    assert.match(census.exposureBoundary.gap, /merge.*readAt.*use.*do not prove exact loadedAt/i);
    assert.deepEqual(census.eligibleObservationRefs, []);
    assert.equal(census.measurementDisposition.status, 'insufficient');
    assert.equal(census.measurementDisposition.proposedAction, 'keep_observe');
    assert.match(census.measurementDisposition.reasons.join(' '), /current version.*adoption.*applied-use/i);
    assert.match(census.measurementDisposition.reasons.join(' '), /comparable.*control.*holdout/i);
  });

  it('reopens the immutable v1 source and proof after the canonical source advances', async () => {
    const { stdout } = await exec('git', ['-C', ROOT, 'show', `${V1_MANIFEST_REVISION}:${SOURCE_ARTIFACT_REF}`]);
    const legacyManifest = parse(stdout);
    const [
      { CapabilityEvolutionMeasurementSourceSchema },
      { validateCapabilityEvolutionMeasurementSource },
      { createFileMeasurementDecisionProofResolver },
    ] = await Promise.all([
      import(
        '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.js'
      ),
      import(
        '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.js'
      ),
      import('../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js'),
    ]);

    CapabilityEvolutionMeasurementSourceSchema.parse(legacyManifest);
    validateCapabilityEvolutionMeasurementSource({
      manifest: legacyManifest,
      ownerUserId: 'default-user',
      projection: {
        program: {
          programId: PROGRAM_ID,
          workspaceId: 'user:default-user',
          lifecycle: 'active',
          stage: 'constituting',
          sequence: 1,
          cycle: 1,
          objectRef: TARGET_REF,
          claimRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: `evolution-claim:${PROGRAM_ID}`,
          },
          valueOwnerRef: CONSUMER_REF,
        },
      },
    });
    assert.deepEqual(legacyManifest.roles.consumer, CONSUMER_REF);
    assert.equal(
      legacyManifest.certificate.certificateId,
      'f267-capability-evolution-development-episode-alignment-e0-v1',
    );

    const resolution = await createFileMeasurementDecisionProofResolver({ repoRoot: ROOT }).resolve({
      ownerUserId: 'default-user',
      evidenceProofRef: {
        ownerFeatureId: 'F267',
        ownerStateRef: 'measurement-proof:f267-capability-evolution-development-episode-alignment-e0-proof-v1',
      },
    });
    assert.equal(resolution.status, 'resolved');
    assert.equal(resolution.proof.status, 'insufficient');
  });

  it('reopens the immutable v2 source and proof after the canonical source advances', async () => {
    const { stdout } = await exec('git', ['-C', ROOT, 'show', `${V2_MANIFEST_REVISION}:${SOURCE_ARTIFACT_REF}`]);
    const v2Manifest = parse(stdout);
    const [
      { CapabilityEvolutionMeasurementSourceSchema },
      { validateCapabilityEvolutionMeasurementSource },
      { createFileMeasurementDecisionProofResolver },
    ] = await Promise.all([
      import(
        '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.js'
      ),
      import(
        '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.js'
      ),
      import('../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js'),
    ]);

    CapabilityEvolutionMeasurementSourceSchema.parse(v2Manifest);
    validateCapabilityEvolutionMeasurementSource({
      manifest: v2Manifest,
      ownerUserId: 'default-user',
      projection: {
        program: {
          programId: PROGRAM_ID,
          workspaceId: 'user:default-user',
          lifecycle: 'active',
          stage: 'instrumenting',
          sequence: 34,
          cycle: 1,
          objectRef: TARGET_REF,
          claimRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: `evolution-claim:${PROGRAM_ID}`,
          },
          valueOwnerRef: CONSUMER_REF,
        },
      },
    });
    assert.deepEqual(v2Manifest.roles.consumer, NAMED_CONSUMER_REF);
    assert.equal(v2Manifest.certificate.certificateId, 'f267-capability-evolution-development-episode-alignment-e0-v2');

    const resolution = await createFileMeasurementDecisionProofResolver({ repoRoot: ROOT }).resolve({
      ownerUserId: 'default-user',
      evidenceProofRef: {
        ownerFeatureId: 'F267',
        ownerStateRef: 'measurement-proof:f267-capability-evolution-development-episode-alignment-e0-proof-v2',
      },
    });
    assert.equal(resolution.status, 'resolved');
    assert.equal(resolution.proof.status, 'insufficient');
  });

  it('binds the current named consumer into the v3 zero-sample F267 source manifest', async () => {
    const manifest = parse(await readFile(SOURCE_REF, 'utf8'));
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await Promise.all([
        import(
          '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.js'
        ),
        import(
          '../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.js'
        ),
      ]);

    CapabilityEvolutionMeasurementSourceSchema.parse(manifest);
    validateCapabilityEvolutionMeasurementSource({
      manifest,
      ownerUserId: 'default-user',
      projection: {
        program: {
          programId: PROGRAM_ID,
          workspaceId: 'user:default-user',
          lifecycle: 'active',
          stage: 'instrumenting',
          sequence: 70,
          cycle: 1,
          objectRef: TARGET_REF,
          claimRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: `evolution-claim:${PROGRAM_ID}`,
          },
          valueOwnerRef: CONSUMER_REF,
        },
      },
    });

    assert.equal(manifest.sourceRevision, CURRENT_SOURCE_REVISION);
    assert.equal(manifest.sourceArtifacts.length, 6);
    for (const sourceArtifact of manifest.sourceArtifacts) {
      const { stdout } = await exec('git', ['-C', ROOT, 'show', `${manifest.sourceRevision}:${sourceArtifact.ref}`]);
      assert.equal(sha256(Buffer.from(stdout)), sourceArtifact.sha256, sourceArtifact.ref);
    }
    assert.deepEqual(manifest.roles, {
      observer: OBSERVER_REF,
      domainOwner: DOMAIN_OWNER_REF,
      consumer: V3_NAMED_CONSUMER_REF,
      calibrator: CALIBRATOR_REF,
    });
    assert.equal(manifest.program.expectedSequence, 70);
    assert.equal(manifest.certificate.certificateId, 'f267-capability-evolution-development-episode-alignment-e0-v3');
    assert.equal(manifest.certificate.decision.consumerFeatureId, 'F100');
    assert.equal(manifest.certificate.decision.consumerOwnerCatId, 'opus55');
    assert.equal(manifest.result.resultId, 'f267-capability-evolution-development-episode-alignment-e0-result-v3');
    assert.equal(manifest.decisionProof.proofId, 'f267-capability-evolution-development-episode-alignment-e0-proof-v3');
    assert.ok(manifest.sourceArtifacts.some(({ ref }) => ref.endsWith('measurement-procedure-v3.yaml')));
    assert.ok(manifest.sourceArtifacts.some(({ ref }) => ref.endsWith('measurement-role-assignment-v3.yaml')));
    assert.ok(manifest.sourceArtifacts.some(({ ref }) => ref.endsWith('observation-census-v2.yaml')));
    assert.ok(manifest.sourceArtifacts.every(({ ref }) => !ref.endsWith('measurement-procedure-v2.yaml')));
    assert.ok(manifest.sourceArtifacts.every(({ ref }) => !ref.endsWith('measurement-role-assignment-v2.yaml')));
    assert.ok(manifest.sourceArtifacts.every(({ ref }) => !ref.endsWith('measurement-procedure-v1.yaml')));
    assert.ok(manifest.sourceArtifacts.every(({ ref }) => !ref.endsWith('measurement-role-assignment-v1.yaml')));
    assert.ok(manifest.result.metrics.every((metric) => metric.n === 0));
    assert.ok(manifest.result.metrics.every((metric) => metric.pointEstimate === null));
    assert.ok(manifest.result.metrics.every((metric) => metric.evidenceStatus === 'insufficient'));
    assert.equal(manifest.result.decision.status, 'insufficient');
    assert.equal(manifest.result.actionProposal.action, 'keep_observe');
    assert.match(manifest.result.decision.reasons.join(' '), /loadedAt.*current-version.*comparable.*control/i);
    assert.match(manifest.result.decision.reasons.join(' '), /optimizer exposure.*promotion holdout/i);
    assert.deepEqual(manifest.ownerObjects, []);
    assert.deepEqual(Object.keys(manifest.decisionProof), [
      'kind',
      'schemaVersion',
      'proofId',
      'generatedAt',
      'subject',
    ]);
  });
});
