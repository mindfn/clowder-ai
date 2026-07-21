/**
 * F257 #6 (slice 6b) — activeStage / actionableStage 分离 (判据①).
 *
 * "active" = which version is currently live (`isActive`). "actionable" = which stage
 * awaits an OPERATOR decision. These are distinct: the live version may have nothing
 * pending, and a non-active version may be the one awaiting a decision.
 *
 * Grounded in the producer — `segment-lifeline-chain.ts` sets governance = `pending`
 * exactly when the winning verdict is alive/dormant (operator must approve/retire), so
 * `governance-pending` is the sole actionable stage in v1.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isActionableStage } from '../components/settings/LifelineChainView';

const SETTINGS_DIR = path.resolve(__dirname, '..', 'components', 'settings');
const read = (n: string) => readFileSync(path.join(SETTINGS_DIR, n), 'utf-8');

describe('F257 #6: actionable stage detection (判据①)', () => {
  it('governance-pending IS the actionable stage (operator decision needed)', () => {
    expect(isActionableStage({ decision: 'pending' }, 'governance')).toBe(true);
  });

  it('approved governance is NOT actionable (decision already made)', () => {
    expect(isActionableStage({ decision: 'approved' }, 'governance')).toBe(false);
  });

  it('non-governance stages are never actionable in v1', () => {
    expect(isActionableStage({ decision: 'pending' }, 'eval')).toBe(false);
    expect(isActionableStage({ decision: 'pending' }, 'tracing')).toBe(false);
    expect(isActionableStage({ decision: 'pending' }, 'version')).toBe(false);
  });

  it('null / absent governance is not actionable', () => {
    expect(isActionableStage(null, 'governance')).toBe(false);
    expect(isActionableStage(undefined, 'governance')).toBe(false);
    expect(isActionableStage({ decision: null }, 'governance')).toBe(false);
  });
});

describe('F257 #6: active vs actionable separation — wiring (判据①)', () => {
  const src = read('LifelineChainView.tsx');

  it('chain marks the actionable stage via a separate channel from the active-version marker', () => {
    expect(src).toContain('isActionableStage');
    expect(src).toMatch(/actionable\?:\s*boolean/); // StageBadge accepts it
    expect(src).toMatch(/actionable\s*&&/); // renders a distinct indicator when actionable
    // active-version marker stays on its own channel (● suffix), independent of actionable.
    expect(src).toContain("suffix={epoch.isActive ? '●' : undefined}");
  });

  it('governance-pending renders the 待处理 operator-action label', () => {
    expect(src).toContain('待处理');
  });
});
