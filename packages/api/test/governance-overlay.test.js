import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { initGovernanceOverlay, getGovernanceDigest } = await import(
  '../dist/domains/cats/services/context/SystemPromptBuilder.js'
);

describe('governance overlay integration (#603)', () => {
  it('initGovernanceOverlay uses base when no overlay files exist', async () => {
    await initGovernanceOverlay();
    const digest = getGovernanceDigest();

    assert.ok(digest.includes('家规'), 'base governance digest should be present');
    assert.ok(!digest.includes('Custom rule'), 'no overlay content when files absent');
  });

  it('initGovernanceOverlay appends .local.md content to digest', async () => {
    const TMP = join(tmpdir(), `governance-overlay-test-${Date.now()}`);
    const refsDir = join(TMP, 'cat-cafe-skills', 'refs');
    await mkdir(refsDir, { recursive: true });
    await writeFile(join(TMP, 'pnpm-workspace.yaml'), '');
    await writeFile(join(refsDir, 'shared-rules.local.md'), '### Fork supplement\nCustom rule here');

    const savedCwd = process.cwd();
    try {
      process.chdir(TMP);
      await initGovernanceOverlay();
      const digest = getGovernanceDigest();

      assert.ok(digest.includes('家规'), 'base governance digest should be present');
      assert.ok(digest.includes('Custom rule here'), '.local.md content should be appended');
    } finally {
      process.chdir(savedCwd);
      await rm(TMP, { recursive: true, force: true });
    }
  });
});
