import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listOwnerArtifactVerdicts } from './artifact-store/artifact-store-reader.js';
import {
  type LegacyReevalCaseMigration,
  loadLegacyReevalCaseMigrations,
  loadLifecycleRootsWithLegacyCases,
} from './legacy-reeval-case-migration.js';
import {
  LIFECYCLE_ROOT_FILENAME,
  type LifecycleRootArtifact,
  readLifecycleRootArtifact,
  scanLifecycleRootArtifacts,
} from './publish-verdict/lifecycle-root-artifact.js';
import type { EvalLifecycleScope } from './reeval-closure-event-log.js';

/**
 * F257 × F266 — where a set of immutable lifecycle roots lives. A space pairs one
 * source of roots with the event-log scope that records what happened to them, and
 * a lifecycle is only ever read, projected, or commanded inside its own space.
 *
 * - The repository space holds roots committed to the product repository, together
 *   with the repository-only history around them (legacy case migrations, the
 *   imported capability-wakeup lifecycle).
 * - An owner space holds the roots of the runtime verdicts one owner published into
 *   the artifact store — every verdict of every artifact, children included.
 *
 * The domain registry is baseline product configuration, so every space reads it
 * from the repository's harness-feedback root.
 */
export type EvalLifecycleSpace =
  | { kind: 'repository'; harnessFeedbackRoot: string }
  | { kind: 'owner'; harnessFeedbackRoot: string; artifactStoreRoot: string; ownerUserId: string };

export interface OwnerArtifactStoreRef {
  artifactStoreRoot: string;
  ownerUserId: string;
}

export function repositoryLifecycleSpace(harnessFeedbackRoot: string): EvalLifecycleSpace {
  return { kind: 'repository', harnessFeedbackRoot };
}

export function ownerLifecycleSpace(harnessFeedbackRoot: string, owner: OwnerArtifactStoreRef): EvalLifecycleSpace {
  return {
    kind: 'owner',
    harnessFeedbackRoot,
    artifactStoreRoot: owner.artifactStoreRoot,
    ownerUserId: owner.ownerUserId,
  };
}

export function lifecycleSpaceScope(space: EvalLifecycleSpace): EvalLifecycleScope {
  return space.kind === 'repository' ? { kind: 'repository' } : { kind: 'owner', ownerUserId: space.ownerUserId };
}

function scanOwnerLifecycleRoots(artifactStoreRoot: string, ownerUserId: string): LifecycleRootArtifact[] {
  return listOwnerArtifactVerdicts(artifactStoreRoot, ownerUserId).flatMap(({ coordinates, bundleDir }) => {
    if (!existsSync(join(bundleDir, LIFECYCLE_ROOT_FILENAME))) return [];
    const root = readLifecycleRootArtifact(bundleDir);
    if (root.verdictId !== coordinates.verdictId) {
      throw new Error(
        `lifecycle root verdictId ${root.verdictId} does not match artifact verdict ${coordinates.verdictId}`,
      );
    }
    return [root];
  });
}

/** The space's roots exactly as stored, without repository history applied. */
export function scanLifecycleSpaceRoots(space: EvalLifecycleSpace): LifecycleRootArtifact[] {
  return space.kind === 'repository'
    ? scanLifecycleRootArtifacts(space.harnessFeedbackRoot)
    : scanOwnerLifecycleRoots(space.artifactStoreRoot, space.ownerUserId);
}

/** The space's roots as lifecycles see them: repository roots gain their legacy stable cases. */
export function loadLifecycleSpaceRoots(space: EvalLifecycleSpace): LifecycleRootArtifact[] {
  return space.kind === 'repository'
    ? loadLifecycleRootsWithLegacyCases(space.harnessFeedbackRoot)
    : scanOwnerLifecycleRoots(space.artifactStoreRoot, space.ownerUserId);
}

/** Legacy case migrations describe committed history, so only the repository space has any. */
export function loadLifecycleSpaceMigrations(space: EvalLifecycleSpace): LegacyReevalCaseMigration[] {
  return space.kind === 'repository' ? loadLegacyReevalCaseMigrations(space.harnessFeedbackRoot) : [];
}
