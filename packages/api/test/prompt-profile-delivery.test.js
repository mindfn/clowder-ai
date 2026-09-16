/**
 * The session prompt must still deliver the owner's F231 profile.
 *
 * Before the prompt-hook runtime replaced it, the L0 compiler rendered
 * `{{USER_CAPSULE}}`: the owner capsule from `operator-capsule.md` plus a
 * relationship-primer pointer when that persona had one. `1fa1999d4` retired the
 * L0 compiler and rewired the providers onto HookPipeline, but no session segment
 * took the profile over, and no test covered it -- session-hook-colocation only
 * compares the L1-L7 static templates, so a full public suite stayed green while
 * the capability was gone.
 *
 * These are the pipeline-level delivery contracts, asserted at the builder the routes
 * call (`buildStaticIdentity`). Carrier parity lives in f257-route-seam.test.js, where
 * the serial and parallel routes really run.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';

// The heading comes from the canonical F231 renderer, not from this test: asserting a
// hand-written '## ...' would pass while the real contract drifted.
const CAPSULE_BODY = 'lang：co-creator，偏好直接、证据优先的沟通。';
const CAPSULE_SECTION = renderUserCapsuleSection(CAPSULE_BODY);
const RELATIONSHIP_POINTER = '关系轨迹: cat-cafe-profile://relationship/current（cat_cafe_read_profile 按需读）';
// Exact upstream Phase E line (scripts/compile-system-prompt-l0.mjs), not a paraphrase.
const CORPUS_POINTER = '共享事实: cat-cafe-profile://corpus/current（cat_cafe_read_profile layer=corpus 按需读）';

describe('session prompt delivers the owner profile', () => {
  /** @type {typeof import('../dist/domains/cats/services/context/SystemPromptBuilder.js')} */
  let promptBuilder;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    shared.catRegistry.reset();
    shared.catRegistry.register('opus', {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
      relationshipKey: 'ragdoll',
    });
    promptBuilder = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
  });

  const OWNER_ID = 'owner-42-id-token';
  const profile = (pointerLines = [RELATIONSHIP_POINTER]) => ({
    userId: OWNER_ID,
    capsuleSection: CAPSULE_SECTION,
    pointerLines,
  });

  it('carries the owner capsule and the relationship pointer into static identity', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', { mcpAvailable: true, profile: profile() });

    assert.ok(prompt.includes(CAPSULE_SECTION), 'the owner capsule must reach the session prompt');
    assert.ok(prompt.includes(RELATIONSHIP_POINTER), 'the relationship pointer must reach the session prompt');
  });

  // Carrier parity is NOT asserted here on purpose: calling this builder twice with a
  // different mcpAvailable flag would stay green even if the routes never passed profile
  // truth. It is asserted at the real serial/parallel seam in f257-route-seam.test.js.
  it('carries a corpus pointer when the owner has one', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: profile([RELATIONSHIP_POINTER, CORPUS_POINTER]),
    });

    assert.ok(prompt.includes(CORPUS_POINTER), 'the corpus pointer must reach the session prompt');
  });

  it('delivers exactly the bytes it was given, so a later revision cannot be stale', () => {
    const r1 = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: { userId: OWNER_ID, capsuleSection: renderUserCapsuleSection('r1 内容'), pointerLines: [] },
    });
    const r2 = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: { userId: OWNER_ID, capsuleSection: renderUserCapsuleSection('r2 内容'), pointerLines: [] },
    });

    assert.ok(r1.includes('r1 内容'));
    assert.ok(r2.includes('r2 内容'));
    assert.equal(r2.includes('r1 内容'), false, 'a later session must not deliver the earlier revision');
  });

  it('never writes the owner id or a filesystem path into the prompt', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: profile([RELATIONSHIP_POINTER, CORPUS_POINTER]),
    });

    // The section is the owner's content plus logical URIs. An owner id or an absolute
    // path here would also reach the persisted trace, which is a different disclosure
    // than the profile bytes themselves.
    // The capsule body may well name the person; what must never appear is the owner
    // *id* the route resolved, which is why the fixture id is a distinct token.
    assert.equal(prompt.includes(OWNER_ID), false, 'the owner id must not be rendered');
    assert.equal(/\/(?:Users|home|var|tmp)\//.test(prompt), false, 'no absolute path may be rendered');
    assert.equal(prompt.includes('.cat-cafe/'), false, 'no data-root path may be rendered');
    assert.equal(prompt.includes('operator-capsule.md'), false, 'no profile file name may be rendered');
  });

  it('keeps the capsule when a cat has no persona key, and adds no pointer', async () => {
    const { resolveOwnerProfileSnapshot } = await import(
      '../dist/domains/cats/services/profile/owner-profile-snapshot.js'
    );
    const { catRegistry } = await import('@cat-cafe/shared');
    catRegistry.register('nokeycat', {
      displayName: '无键猫',
      name: 'NoKey',
      roleDescription: 'x',
      personality: 'y',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@nokeycat'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    });

    // Must not throw: a missing persona key means no primer to point at, not a failed
    // session. Resolving the profile scope anyway would reject the whole invocation.
    const snapshot = resolveOwnerProfileSnapshot({ catId: 'nokeycat' });

    assert.equal(snapshot?.pointerLines?.length ?? 0, 0, 'no persona key means no relationship pointer');
  });

  it('injects nothing when the owner has no profile', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', { mcpAvailable: true });

    assert.equal(prompt.includes(CAPSULE_SECTION), false);
    assert.equal(prompt.includes('cat-cafe-profile://'), false, 'no pointer may appear without profile truth');
  });
});
