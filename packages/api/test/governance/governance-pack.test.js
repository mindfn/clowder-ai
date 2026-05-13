import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computePackChecksum,
  GOVERNANCE_PACK_VERSION,
  getGovernanceManagedBlock,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
} from '../../dist/config/governance/governance-pack.js';

describe('governance-pack', () => {
  it('managed block has start/end markers', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(MANAGED_BLOCK_START));
    assert.ok(block.includes(MANAGED_BLOCK_END));
  });

  it('references .env port config instead of hardcoded ports (#601/#602)', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('FRONTEND_PORT'), 'Should reference FRONTEND_PORT env var');
    assert.ok(block.includes('API_SERVER_PORT'), 'Should reference API_SERVER_PORT env var');
    assert.ok(!block.includes('3003'), 'Should not hardcode port 3003');
    assert.ok(!block.includes('6399'), 'Should not hardcode port 6399');
  });

  it('port reservation concept is present', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('Port Boundary'), 'Port boundary guidance should be present');
    assert.ok(block.includes('Redis Isolation'), 'Redis isolation guidance should be present');
  });

  it('managed block includes governance rules from shared-rules', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('self-review'), 'Should include no-self-review rule');
    assert.ok(block.includes('Identity'), 'Should include identity constraint');
  });

  it('managed block includes methodology intro', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('frontmatter'));
    assert.ok(block.includes('Feature lifecycle'));
    assert.ok(block.includes('SOP'));
  });

  it('includes pack version', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes(GOVERNANCE_PACK_VERSION));
  });

  it('includes provider name', () => {
    assert.ok(getGovernanceManagedBlock('claude').includes('claude'));
    assert.ok(getGovernanceManagedBlock('codex').includes('codex'));
    assert.ok(getGovernanceManagedBlock('gemini').includes('gemini'));
    assert.ok(getGovernanceManagedBlock('kimi').includes('kimi'));
  });

  it('pack version is semver', () => {
    assert.match(GOVERNANCE_PACK_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('checksum is stable for same content', () => {
    const a = computePackChecksum();
    const b = computePackChecksum();
    assert.strictEqual(a, b);
  });

  it('checksum is a 12-char hex string', () => {
    const checksum = computePackChecksum();
    assert.match(checksum, /^[0-9a-f]{12}$/);
  });

  it('collaboration standards reference shared-rules and skills', () => {
    const block = getGovernanceManagedBlock('claude');
    assert.ok(block.includes('shared-rules.md'));
    assert.ok(block.includes('cat-cafe-skills'));
  });

  it('pack version is 1.4.0', () => {
    assert.equal(GOVERNANCE_PACK_VERSION, '1.4.0');
  });
});
