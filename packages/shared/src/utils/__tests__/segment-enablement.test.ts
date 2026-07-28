import { describe, expect, it } from 'vitest';
import {
  type ResolveSegmentEnablementMatrixInput,
  resolveSegmentEnablementMatrix,
  type SegmentAction,
} from '../segment-enablement.js';

const DEFAULT_INPUT: ResolveSegmentEnablementMatrixInput = {
  segmentId: 'S1',
  safetyTier: 'editable',
  allowLocalOverride: true,
  disableable: true,
  enabled: true,
  hasOverride: false,
  hasContentOverride: false,
  hasBackup: false,
};

const ALL_ACTIONS: SegmentAction[] = ['edit', 'disable', 'enable', 'rollback', 'restoreBackup', 'activateVersion'];

function allowedActions(matrix: ReturnType<typeof resolveSegmentEnablementMatrix>): SegmentAction[] {
  return ALL_ACTIONS.filter((a) => matrix.actions[a].allowed);
}

function blockedReason(matrix: ReturnType<typeof resolveSegmentEnablementMatrix>, action: SegmentAction) {
  return matrix.actions[action].reasonCode;
}

describe('resolveSegmentEnablementMatrix', () => {
  it('editable + allowLocalOverride + disableable + enabled baseline', () => {
    const m = resolveSegmentEnablementMatrix(DEFAULT_INPUT);
    expect(allowedActions(m).sort()).toEqual(['disable', 'edit'].sort());
    expect(m.actions.edit.reasonCode).toBeNull();
    expect(m.actions.disable.reasonCode).toBeNull();
    expect(blockedReason(m, 'enable')).toBe('already-enabled');
    expect(blockedReason(m, 'rollback')).toBe('no-override');
    expect(blockedReason(m, 'restoreBackup')).toBe('no-backup');
    expect(blockedReason(m, 'activateVersion')).toBe('no-content-override');
  });

  it('readonly blocks content mutations but allows disable when disableable', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'readonly' });
    expect(allowedActions(m)).toEqual(['disable']);
    expect(blockedReason(m, 'edit')).toBe('safety-tier-readonly');
    expect(blockedReason(m, 'restoreBackup')).toBe('no-backup');
    expect(blockedReason(m, 'activateVersion')).toBe('no-content-override');
  });

  it('allowLocalOverride=false blocks edit/restore even when editable', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, allowLocalOverride: false });
    expect(allowedActions(m)).toEqual(['disable']);
    expect(blockedReason(m, 'edit')).toBe('no-local-overlay-path');
    expect(blockedReason(m, 'restoreBackup')).toBe('no-backup');
  });

  it('disableable=false blocks disable but leaves edit intact', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, disableable: false });
    expect(allowedActions(m)).toEqual(['edit']);
    expect(blockedReason(m, 'disable')).toBe('not-disableable');
  });

  it('disabled override enables enable action and blocks disable', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      enabled: false,
      hasOverride: true,
      hasContentOverride: false,
    });
    expect(allowedActions(m).sort()).toEqual(['edit', 'enable', 'rollback'].sort());
    expect(blockedReason(m, 'disable')).toBe('already-disabled');
    expect(blockedReason(m, 'enable')).toBeNull();
  });

  it('content override enables rollback + activateVersion', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      hasOverride: true,
      hasContentOverride: true,
      hasBackup: true,
    });
    expect(allowedActions(m).sort()).toEqual(
      ['disable', 'edit', 'rollback', 'restoreBackup', 'activateVersion'].sort(),
    );
  });

  it('readonly + no overlay path: reason prefers safety-tier over no-overlay when backup exists', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'readonly',
      allowLocalOverride: false,
      hasBackup: true,
    });
    expect(blockedReason(m, 'edit')).toBe('safety-tier-readonly');
    expect(blockedReason(m, 'restoreBackup')).toBe('safety-tier-readonly');
  });

  it('limited-edit does not block matrix edit (source gate enforced server-side)', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'limited-edit' });
    expect(m.actions.edit.allowed).toBe(true);
    expect(m.actions.activateVersion.allowed).toBe(false);
    expect(blockedReason(m, 'activateVersion')).toBe('no-content-override');
  });

  it('disabled without override cannot be enabled', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      enabled: false,
      hasOverride: false,
    });
    expect(blockedReason(m, 'enable')).toBe('no-disable-override');
  });

  it('exposes dimension fields on matrix', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'limited-edit',
      disableable: false,
    });
    expect(m.segmentId).toBe('S1');
    expect(m.safetyTier).toBe('limited-edit');
    expect(m.allowLocalOverride).toBe(true);
    expect(m.disableable).toBe(false);
    expect(m.overrideState.enabled).toBe(true);
  });
});
