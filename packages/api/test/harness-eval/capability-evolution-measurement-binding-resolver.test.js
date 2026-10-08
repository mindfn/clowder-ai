import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const programId = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
const sourceArtifactRef =
  'docs/harness-feedback/measurement-sources/capability-evolution/evolution-program-ba0f4524e49cc879279164d5b272cf8c.yaml';
const sourcePath = resolve(repoRoot, sourceArtifactRef);
const publishedV2Revision = 'f11039cdc036a3a6be2c05ea0192f236b8088c5e';
const exec = promisify(execFile);
const evidenceProofRef = {
  ownerFeatureId: 'F267',
  ownerStateRef: 'measurement-proof:f267-capability-evolution-development-episode-alignment-e0-proof-v2',
};

async function productionProgram() {
  const manifest = parse(await readFile(sourcePath, 'utf8'));
  return programFromManifest(manifest);
}

function programFromManifest(manifest) {
  return {
    program: {
      programId,
      workspaceId: 'user:default-user',
      sequence: manifest.program.expectedSequence,
      objectRef: manifest.program.targetRef,
      claimRef: manifest.program.claimRef,
      valueOwnerRef: { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' },
    },
  };
}

async function publishedV2Program() {
  const { stdout } = await exec('git', ['-C', repoRoot, 'show', `${publishedV2Revision}:${sourceArtifactRef}`]);
  return programFromManifest(parse(stdout));
}

describe('F267 trusted-main measurement constitution binding', () => {
  it('reopens the landed ba0f insufficient publication and derives only canonical refs', async () => {
    const { createGitCapabilityEvolutionMeasurementBindingResolver } = await import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-binding-resolver.js'
    );
    const resolver = createGitCapabilityEvolutionMeasurementBindingResolver({
      repoRoot,
      mainRef: publishedV2Revision,
      fetchMain: false,
    });

    const result = await resolver.resolveMeasurementConstitution({
      ownerUserId: 'default-user',
      program: await publishedV2Program(),
      evidenceProofRef,
    });

    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.binding.measurementCertificateRef, {
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-certificate:f267-capability-evolution-development-episode-alignment-e0-v2',
    });
    assert.deepEqual(result.binding.measurementRoleRefs.consumer, {
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-role:f267-capability-evolution-development-episode-alignment-e0-proof-v2:consumer',
    });
    assert.deepEqual(result.binding.sourceRef, {
      ownerFeatureId: 'F100',
      ownerStateRef: 'capability-evolution-measurement-source:evolution-program-ba0f4524e49cc879279164d5b272cf8c',
    });
  });

  it('rejects a different owner user or proof identity without returning partial refs', async () => {
    const { createGitCapabilityEvolutionMeasurementBindingResolver } = await import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-binding-resolver.js'
    );
    const resolver = createGitCapabilityEvolutionMeasurementBindingResolver({
      repoRoot,
      mainRef: 'HEAD',
      fetchMain: false,
    });
    const program = await productionProgram();

    assert.equal(
      (
        await resolver.resolveMeasurementConstitution({
          ownerUserId: 'someone-else',
          program,
          evidenceProofRef,
        })
      ).status,
      'unavailable',
    );
    assert.deepEqual(
      await resolver.resolveMeasurementConstitution({
        ownerUserId: 'default-user',
        program,
        evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:missing-v2' },
      }),
      {
        status: 'unavailable',
        reason:
          'published artifact is not a regular Git blob: docs/harness-feedback/decision-proofs/records/missing-v2.yaml',
      },
    );
  });

  it('rejects a superseded publication even when its historical sequence pin matches', async () => {
    const { createGitCapabilityEvolutionMeasurementBindingResolver } = await import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-binding-resolver.js'
    );
    const resolver = createGitCapabilityEvolutionMeasurementBindingResolver({
      repoRoot,
      mainRef: 'HEAD',
      fetchMain: false,
    });
    const program = await productionProgram();
    program.program.sequence = 1;

    const result = await resolver.resolveMeasurementConstitution({
      ownerUserId: 'default-user',
      program,
      evidenceProofRef: {
        ownerFeatureId: 'F267',
        ownerStateRef: 'measurement-proof:f267-capability-evolution-development-episode-alignment-e0-proof-v1',
      },
    });

    assert.equal(result.status, 'unavailable', JSON.stringify(result));
    assert.match(result.reason, /published proof no longer names the current owner source/u);
  });
});
