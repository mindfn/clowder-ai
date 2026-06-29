// @ts-check

/**
 * #1049 — Startup self-healing: capabilities.json with missing managed MCPs.
 *
 * When capabilities.json exists but is missing core managed MCP entries
 * (cat-cafe-collab, cat-cafe-memory, cat-cafe-signals, etc.),
 * `healCatCafeMcpTopology` should restore them automatically.
 *
 * Previously, the heal chain could only:
 *   - Migrate legacy cat-cafe → splits (if legacy entry existed)
 *   - Add supplemental splits (if core 3 already existed)
 * It could NOT restore missing core splits from scratch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { healCatCafeMcpTopology } = await import('../dist/config/capabilities/capability-orchestrator.js');

const CORE_SPLIT_IDS = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'];
const ALL_SPLIT_IDS = [
  'cat-cafe-collab',
  'cat-cafe-memory',
  'cat-cafe-signals',
  'cat-cafe-limb',
  'cat-cafe-audio',
  'cat-cafe-finance',
];

/** A capabilities config with only external MCP (no managed splits at all). */
function configWithNoManagedMcps() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'some-external-mcp',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'node', args: ['ext.js'] },
      },
    ],
  };
}

/** A capabilities config with only 1 of 3 core managed splits. */
function configWithPartialCoreMcps() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
      {
        id: 'some-external-mcp',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'node', args: ['ext.js'] },
      },
    ],
  };
}

/** A capabilities config with skills but no MCPs at all. */
function configWithSkillsOnly() {
  return {
    version: 2,
    capabilities: [
      {
        id: 'some-skill',
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
      },
    ],
  };
}

describe('#1049 — healCatCafeMcpTopology restores missing managed MCPs', () => {
  it('adds all managed splits when none exist', () => {
    const input = configWithNoManagedMcps();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of ALL_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing managed MCP: ${id}`);
    }

    // External MCP should be preserved
    const externalMcp = result.config.capabilities.find((c) => c.id === 'some-external-mcp');
    assert.ok(externalMcp, 'external MCP should be preserved');
  });

  it('adds missing core splits when only some exist', () => {
    const input = configWithPartialCoreMcps();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of CORE_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing core MCP: ${id}`);
    }
  });

  it('adds managed MCPs when only skills exist', () => {
    const input = configWithSkillsOnly();
    const result = healCatCafeMcpTopology(input, { catCafeRepoRoot: '/fake/root' });

    assert.ok(result.migrated, 'should report migration occurred');

    const managedIds = result.config.capabilities
      .filter((c) => c.type === 'mcp' && c.source === 'cat-cafe')
      .map((c) => c.id);

    for (const id of ALL_SPLIT_IDS) {
      assert.ok(managedIds.includes(id), `missing managed MCP: ${id}`);
    }

    // Skills should be preserved
    const skill = result.config.capabilities.find((c) => c.id === 'some-skill');
    assert.ok(skill, 'existing skills should be preserved');
  });

  it('does not duplicate when all managed MCPs already exist', () => {
    // Build a complete config with all managed MCPs
    const config = {
      version: 2,
      capabilities: ALL_SPLIT_IDS.map((id) => ({
        id,
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [`${id.replace('cat-cafe-', '')}.js`] },
      })),
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });

    // Count managed MCPs — should be exactly 6, not 12
    const managedCount = result.config.capabilities.filter((c) => c.type === 'mcp' && c.source === 'cat-cafe').length;
    assert.equal(managedCount, ALL_SPLIT_IDS.length, 'should not duplicate managed MCPs');
  });

  it('inherits enabled state from existing managed splits', () => {
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: false,
          globalEnabled: false,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated);

    // Newly added splits should inherit the disabled state from existing collab
    const newMemory = result.config.capabilities.find((c) => c.id === 'cat-cafe-memory' && c.source === 'cat-cafe');
    assert.ok(newMemory, 'cat-cafe-memory should be added');
    assert.equal(newMemory.globalEnabled, false, 'should inherit disabled state');
  });

  it('preserves legacy overrides→blockedCats during migration (codex PR #13 P1)', () => {
    // Regression test: legacy `cat-cafe` entry has per-cat overrides.
    // The heal chain must run legacy migration FIRST (overrides→blockedCats),
    // then ensureCoreManagedMcps fills gaps. If ensureCoreManagedMcps ran first,
    // the legacy migration would become a no-op and overrides would be lost,
    // silently re-enabling access for blocked cats.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [
            { catId: 'ragdoll', enabled: false },
            { catId: 'maine-coon', enabled: true },
          ],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // Legacy `cat-cafe` entry should be removed (migrated to splits)
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.equal(legacyEntry, undefined, 'legacy cat-cafe entry should be removed');

    // All managed splits should exist
    for (const id of ALL_SPLIT_IDS) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe');
      assert.ok(split, `managed split ${id} should exist`);

      // The blocked cat from overrides must be preserved as blockedCats
      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('ragdoll'),
        `${id} must have ragdoll in blockedCats (legacy overrides preservation)`,
      );
    }
  });

  it('preserves legacy overrides in partial-legacy form (codex PR #13 re-review P1)', () => {
    // Regression test: legacy `cat-cafe` with overrides PLUS an existing managed
    // split (cat-cafe-collab). migrateLegacyCatCafeCapability bails because
    // hasManagedSplit=true; ensureCoreManagedMcps must:
    //   1. Propagate legacy overrides→blockedCats to newly added splits
    //   2. Propagate legacy overrides→blockedCats to the existing split (cat-cafe-collab)
    // Without this fix, ensureCatCafeMainServer removes legacy `cat-cafe` and
    // all splits end up with blockedCats=undefined — silently re-enabling blocked cats.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [
            { catId: 'codex', enabled: false },
            { catId: 'ragdoll', enabled: true },
          ],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          // No blockedCats — the partial split was created without overrides conversion
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // Legacy `cat-cafe` entry should be removed
    const legacyEntry = result.config.capabilities.find((c) => c.id === 'cat-cafe' && c.source === 'cat-cafe');
    assert.equal(legacyEntry, undefined, 'legacy cat-cafe entry should be removed');

    // ALL managed splits (including pre-existing cat-cafe-collab) must have blockedCats
    for (const id of ALL_SPLIT_IDS) {
      const split = result.config.capabilities.find((c) => c.id === id && c.source === 'cat-cafe');
      assert.ok(split, `managed split ${id} should exist`);

      assert.ok(
        Array.isArray(split.blockedCats) && split.blockedCats.includes('codex'),
        `${id} must have codex in blockedCats (partial-legacy overrides propagation)`,
      );

      // ragdoll was enabled:true in overrides — should NOT appear in blockedCats
      assert.ok(
        !split.blockedCats.includes('ragdoll'),
        `${id} must NOT have ragdoll in blockedCats (ragdoll was allowed)`,
      );
    }
  });

  it('preserves existing blockedCats when legacy overrides are also present', () => {
    // Edge case: existing split already has its own blockedCats.
    // Legacy overrides should NOT overwrite explicit blockedCats on existing splits.
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['index.js'] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
          blockedCats: ['siamese'],
        },
      ],
    };

    const result = healCatCafeMcpTopology(config, { catCafeRepoRoot: '/fake/root' });
    assert.ok(result.migrated, 'should report migration occurred');

    // cat-cafe-collab had explicit blockedCats — those should be preserved, not overwritten
    const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab' && c.source === 'cat-cafe');
    assert.ok(collab, 'cat-cafe-collab should exist');
    assert.ok(
      Array.isArray(collab.blockedCats) && collab.blockedCats.includes('siamese'),
      'cat-cafe-collab should keep its original blockedCats',
    );

    // Newly added splits (no pre-existing blockedCats) should get legacy overrides
    const memory = result.config.capabilities.find((c) => c.id === 'cat-cafe-memory' && c.source === 'cat-cafe');
    assert.ok(memory, 'cat-cafe-memory should exist');
    assert.ok(
      Array.isArray(memory.blockedCats) && memory.blockedCats.includes('codex'),
      'cat-cafe-memory should inherit codex from legacy overrides',
    );
  });
});
