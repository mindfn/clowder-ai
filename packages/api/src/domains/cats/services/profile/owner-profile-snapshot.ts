import { catRegistry } from '@cat-cafe/shared';
import { CURRENT_RELATIONSHIP_PROFILE_URI, renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import { installOwnerUserId } from '../../../../config/install-owner.js';
import type { OwnerProfileSnapshot } from '../context/SystemPromptBuilder.js';
import { FileProfileRepository } from './ProfileRepository.js';

/**
 * Resolve the owner's F231 profile once per session, for the S14 session segment.
 *
 * The routes call this and hand the result to `buildStaticIdentity`, so every carrier
 * delivers the same bytes and durable evidence can bind exactly what was delivered.
 * The pipeline itself stays pure: it never reads these files.
 *
 * Owner selection matches what the retired L0 compiler used
 * (`CAT_CAFE_USER_ID ?? DEFAULT_PROFILE_USER_ID`), now routed through the install's one
 * owner identity so a configured trust anchor is honored too.
 *
 * Pointers are existence-gated and never carry content (INV-6): a session says the
 * relationship trajectory exists and how to read it, not what it says.
 */
export function resolveOwnerProfileSnapshot(options: {
  catId: string;
  repository?: FileProfileRepository;
  env?: NodeJS.ProcessEnv;
}): OwnerProfileSnapshot | null {
  const env = options.env ?? process.env;
  const userId = installOwnerUserId(env);
  const repository = options.repository ?? new FileProfileRepository();

  const capsule = repository.readCapsule(userId);
  const capsuleSection = capsule ? renderUserCapsuleSection(capsule.content) : '';

  const pointerLines: string[] = [];
  // The capsule and the relationship primer are independently optional layers. A cat
  // without a persona key simply has no primer to point at; resolving the scope anyway
  // would throw and fail the whole invocation over a missing pointer, which is a worse
  // regression than the missing line. (The retired L0 compiler threw here, but it ran in
  // a subprocess that only compiled that cat's prompt.)
  const relationshipKey = catRegistry.tryGet(options.catId)?.config.relationshipKey;
  if (relationshipKey) {
    const primer = repository.readPrimer(repository.scope(userId, options.catId));
    if (primer) {
      pointerLines.push(`关系轨迹: ${CURRENT_RELATIONSHIP_PROFILE_URI}（cat_cafe_read_profile 按需读）`);
    }
  }

  if (!capsuleSection && pointerLines.length === 0) return null;
  return { userId, ...(capsuleSection ? { capsuleSection } : {}), pointerLines };
}
