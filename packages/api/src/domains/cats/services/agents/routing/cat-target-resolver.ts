import type { CatAlternative, CatId, CatRoutingError } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getRoster } from '../../../../../config/cat-config-loader.js';

function buildAlts(excludeId: string | null, preferFamily?: string): CatAlternative[] {
  const roster = getRoster();
  const configs = catRegistry.getAllConfigs();
  return Object.entries(roster)
    .filter(([id, e]) => id !== excludeId && e.available && catRegistry.has(id))
    .map(([id, e]) => ({
      catId: id as CatId,
      mention: configs[id]?.mentionPatterns[0] ?? `@${id}`,
      displayName: configs[id]?.displayName ?? id,
      family: e.family,
    }))
    .sort((a, b) => {
      const fd = +(a.family !== preferFamily) - +(b.family !== preferFamily);
      const la = roster[a.catId]?.lead ? 0 : 1;
      const lb = roster[b.catId]?.lead ? 0 : 1;
      return fd || la - lb || a.catId.localeCompare(b.catId);
    });
}

/**
 * F257 #1: group registered mention patterns by their normalized text
 * (trim + lowercase — same basis as pattern matching). A key with >1 holder is
 * ambiguous. Shared by resolveCatTarget / AgentRouter / a2a-mentions so all
 * three routing surfaces see the identical holder view.
 */
export function groupPatternHolders(): Map<string, CatId[]> {
  const holdersByPattern = new Map<string, CatId[]>();
  for (const [id, cfg] of Object.entries(catRegistry.getAllConfigs())) {
    for (const p of cfg.mentionPatterns) {
      const key = p.trim().toLowerCase();
      if (!key) continue;
      const holders = holdersByPattern.get(key) ?? [];
      if (!holders.includes(id as CatId)) holders.push(id as CatId);
      holdersByPattern.set(key, holders);
    }
  }
  return holdersByPattern;
}

/**
 * F257 #1 (dev-628ea4d1): disambiguation candidates for a multi-holder pattern.
 * Each candidate carries an UNAMBIGUOUS handle: prefer a pattern no other cat
 * shares; fall back to @catId (catIds are globally unique by toAllCatConfigs).
 */
export function buildAmbiguousCandidates(holderIds: readonly string[]): CatAlternative[] {
  const roster = getRoster();
  const configs = catRegistry.getAllConfigs();
  const holdersByPattern = groupPatternHolders();
  return holderIds.map((id) => {
    const cfg = configs[id];
    const uniquePattern = cfg?.mentionPatterns.find(
      (p) => (holdersByPattern.get(p.trim().toLowerCase()) ?? []).length === 1,
    );
    return {
      catId: id as CatId,
      mention: uniquePattern ?? `@${id}`,
      displayName: cfg?.displayName ?? id,
      family: roster[id]?.family ?? '',
    };
  });
}

export function resolveCatTarget(mentionOrId: string): { ok: CatId } | { error: CatRoutingError } {
  const input = (mentionOrId.startsWith('@') ? mentionOrId.slice(1) : mentionOrId).toLowerCase();
  const configs = catRegistry.getAllConfigs();
  let catId: string | undefined = catRegistry.has(input) ? input : undefined;
  if (!catId) {
    // F257 #1: collect ALL pattern holders instead of first-hit — a pattern held
    // by more than one cat must refuse resolution rather than silently pick one.
    const holders: string[] = [];
    for (const [id, cfg] of Object.entries(configs)) {
      const hit = cfg.mentionPatterns.some((p) => (p.startsWith('@') ? p.slice(1) : p).toLowerCase() === input);
      if (hit && !holders.includes(id)) holders.push(id);
    }
    if (holders.length > 1) {
      return {
        error: { kind: 'mention_ambiguous', mention: mentionOrId, candidates: buildAmbiguousCandidates(holders) },
      };
    }
    catId = holders[0];
  }
  if (!catId) return { error: { kind: 'cat_not_found', mention: mentionOrId, alternatives: buildAlts(null) } };
  // KD-9: two-step check — isCatAvailable not used (it returns true for not-in-roster)
  // cats not in roster = available (backward compat); only explicit available:false = disabled
  const entry = getRoster()[catId];
  if (entry && entry.available === false) {
    return {
      error: {
        kind: 'cat_disabled',
        catId: catId as CatId,
        displayName: configs[catId]?.displayName ?? catId,
        alternatives: buildAlts(catId, entry.family),
      },
    };
  }
  return { ok: catId as CatId };
}
