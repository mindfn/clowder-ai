import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADD_CHANGE, DISABLE_CHANGE, ENABLE_NOOP_CHANGE, MODIFY_CHANGE, SCENARIOS } from '../fixtures';

/**
 * sol's P3 on 09ffa8bd9: `satisfies` proves shape, not producibility, and the
 * previous "verified against the manifest" values were hand-copied. Every
 * semantic invariant these fixtures depend on is asserted here against the
 * repository files themselves, so drift fails a test instead of shipping a
 * demo that looks right.
 *
 * The parser below is deliberately self-checked: an earlier hand-rolled parse
 * of this manifest silently mis-attributed every flow-style item (`- { unitId:
 * D8, ... }`) to the preceding block-style unit, and produced confident garbage.
 * A wrong verifier is worse than no verifier, so the item count is asserted
 * before any membership claim is made.
 */

const REPO_ROOT = resolve(__dirname, '../../../../../../..');
const MANIFEST = resolve(REPO_ROOT, 'docs/harness-feedback/objectives/unit-evaluation-manifest.yaml');

interface ParsedUnit {
  unitId: string;
  objectiveIds: string[];
}

function parseUnitManifest(): ParsedUnit[] {
  const raw = readFileSync(MANIFEST, 'utf8');
  const section = raw.slice(raw.indexOf('\nunits:'));
  // Items start at two-space indent and come in block (`- unitId:`) and flow
  // (`- { unitId: ... }`) styles; both are split the same way.
  const items = section.split(/\n {2}- +/).slice(1);
  return items.map((item) => {
    const unitId = /unitId:\s*([A-Za-z0-9_-]+)/.exec(item)?.[1];
    if (!unitId) throw new Error(`unit_manifest_item_without_unit_id: ${item.slice(0, 60)}`);
    return { unitId, objectiveIds: [...item.matchAll(/objectiveId:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]) };
  });
}

function membersOf(objectiveId: string): string[] {
  return parseUnitManifest()
    .filter((unit) => unit.objectiveIds.includes(objectiveId))
    .map((unit) => unit.unitId)
    .sort();
}

function hookManifestOf(assetDirGlobPrefix: string): string {
  const hooksRoot = resolve(REPO_ROOT, 'assets/prompt-hooks');
  const dir = readdirSync(hooksRoot).find((name) => name.startsWith(assetDirGlobPrefix));
  if (!dir) throw new Error(`hook_dir_not_found:${assetDirGlobPrefix}`);
  return readFileSync(resolve(hooksRoot, dir, 'hook.yaml'), 'utf8');
}

describe('F257 governance fixture contract', () => {
  it('parses every manifest item, including flow-style entries', () => {
    const units = parseUnitManifest();
    const rawCount = (readFileSync(MANIFEST, 'utf8').match(/unitId:/g) ?? []).length;
    // If these diverge the parser is dropping or merging items, and every
    // membership assertion below would be confidently wrong.
    expect(units).toHaveLength(rawCount);
    expect(units.every((unit) => unit.objectiveIds.length > 0)).toBe(true);
  });

  it('keeps the disable fixture on a unit the executor will actually disable', () => {
    expect(DISABLE_CHANGE.action).toBe('disable');
    expect(hookManifestOf(`${DISABLE_CHANGE.unitId.toLowerCase()}-`)).toMatch(/^disableable:\s*true$/m);
    // The unit the first attempt used must stay excluded for the stated reason.
    expect(hookManifestOf('l4-')).toMatch(/^disableable:\s*false$/m);
  });

  it('derives remainingMemberCount from the manifest rather than by hand', () => {
    const afterDisable = membersOf(DISABLE_CHANGE.objectiveImpact.objectiveId).filter(
      (unitId) => unitId !== DISABLE_CHANGE.unitId,
    );
    expect(DISABLE_CHANGE.objectiveImpact.remainingMemberCount).toBe(afterDisable.length);

    const afterEnable = membersOf(ENABLE_NOOP_CHANGE.objectiveImpact.objectiveId).filter(
      (unitId) => unitId !== ENABLE_NOOP_CHANGE.unitId,
    );
    expect(ENABLE_NOOP_CHANGE.objectiveImpact.remainingMemberCount).toBe(afterEnable.length);
  });

  it('binds every enablement fixture to an objective its unit is registered under', () => {
    for (const change of [DISABLE_CHANGE, ENABLE_NOOP_CHANGE]) {
      expect(membersOf(change.objectiveImpact.objectiveId)).toContain(change.unitId);
    }
  });

  it('attaches the added unit to a real objective and obeys the writer validation rules', () => {
    // HarnessUnitDirectoryWriter.validate, encoded.
    expect(ADD_CHANGE.assetSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    expect(ADD_CHANGE.assetSlug.startsWith(ADD_CHANGE.unitId.toLowerCase())).toBe(true);
    expect(ADD_CHANGE.manifest.template).toBe(ADD_CHANGE.manifest.template.split('/').pop());
    expect(ADD_CHANGE.manifest.template.endsWith('.md')).toBe(true);
    expect(ADD_CHANGE.manifest.version).toBe(1);
    expect('resolver' in ADD_CHANGE.manifest).toBe(false);
    expect(ADD_CHANGE.content.trim().length).toBeGreaterThan(0);
    expect(ADD_CHANGE.objectives).toHaveLength(1);
    expect('clauseId' in ADD_CHANGE.objectives[0]).toBe(false);
    // The objective must exist; the new unit itself must not already be registered.
    expect(membersOf(ADD_CHANGE.objectives[0].objectiveId).length).toBeGreaterThan(0);
    expect(parseUnitManifest().some((unit) => unit.unitId === ADD_CHANGE.unitId)).toBe(false);
    // hydrateAdd emits hookId = unitId, not the asset slug.
    expect(ADD_CHANGE.hookId).toBe(ADD_CHANGE.unitId);
  });

  it('keeps the modify fixture on a registered unit', () => {
    expect(parseUnitManifest().some((unit) => unit.unitId === MODIFY_CHANGE.unitId)).toBe(true);
  });

  it('exposes one scenario per artifact operation without duplicates', () => {
    expect(SCENARIOS.map((scenario) => scenario.change.action)).toEqual(['add', 'disable', 'enable', 'modify']);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
  });
});
