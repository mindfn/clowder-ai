import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const TMP = join(tmpdir(), `governance-overlay-test-${Date.now()}`);
const FAKE_RULES_DIR = join(TMP, 'cat-cafe-skills', 'refs');

describe('governance overlay integration (#603)', () => {
  beforeEach(async () => {
    await mkdir(FAKE_RULES_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    mock.restoreAll();
  });

  it('initGovernanceOverlay appends .local.md content to digest', async () => {
    await writeFile(join(FAKE_RULES_DIR, 'shared-rules.local.md'), '### Fork supplement\nCustom rule here');

    mock.module('../dist/utils/monorepo-root.js', {
      namedExports: { findMonorepoRoot: () => TMP },
    });

    const { initGovernanceOverlay } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    await initGovernanceOverlay();

    const { getGovernanceDigest } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const digest = getGovernanceDigest();

    assert.ok(digest.includes('家规'), 'base governance digest should be present');
    assert.ok(digest.includes('Custom rule here'), '.local.md content should be appended');
  });

  it('initGovernanceOverlay uses base when no overlay files exist', async () => {
    mock.module('../dist/utils/monorepo-root.js', {
      namedExports: { findMonorepoRoot: () => TMP },
    });

    const mod = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    await mod.initGovernanceOverlay();
    const digest = mod.getGovernanceDigest();

    assert.ok(digest.includes('家规'), 'base governance digest should be present');
    assert.ok(!digest.includes('Custom rule'), 'no overlay content when files absent');
  });
});
