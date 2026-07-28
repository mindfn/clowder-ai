/**
 * F257 Console 判据⑥ — Segment enablement matrix.
 *
 * Centralizes the `safetyTier × allowLocalOverride × disableable × overrideState`
 * decision table so API, read-model, and Console UI share one contract.
 */

import type { HookManifest, SafetyTier } from '../types/prompt-hook.js';

export type SegmentAction = 'edit' | 'disable' | 'enable' | 'rollback' | 'restoreBackup' | 'activateVersion';

export interface SegmentActionPermission {
  allowed: boolean;
  /** Human-readable reason when blocked; null when allowed. */
  reason: string | null;
  /** Machine-readable reason code when blocked; null when allowed. */
  reasonCode: string | null;
}

export interface SegmentEnablementMatrix {
  segmentId: string;
  safetyTier: SafetyTier;
  allowLocalOverride: boolean;
  disableable: boolean;
  overrideState: {
    /** Effective enabled state (override false → manifest baseline true). */
    enabled: boolean;
    /** Any override record exists in the store. */
    hasOverride: boolean;
    /** A content override is currently active. */
    hasContentOverride: boolean;
    /** A .local.bak rollback snapshot exists. */
    hasBackup: boolean;
  };
  actions: Record<SegmentAction, SegmentActionPermission>;
}

export interface ResolveSegmentEnablementMatrixInput {
  segmentId: string;
  safetyTier: SafetyTier;
  allowLocalOverride: boolean;
  disableable: boolean;
  enabled: boolean;
  hasOverride: boolean;
  hasContentOverride: boolean;
  hasBackup: boolean;
}

/** Compute the unified enablement matrix for a segment. */
export function resolveSegmentEnablementMatrix(input: ResolveSegmentEnablementMatrixInput): SegmentEnablementMatrix {
  const {
    segmentId,
    safetyTier,
    allowLocalOverride,
    disableable,
    enabled,
    hasOverride,
    hasContentOverride,
    hasBackup,
  } = input;

  const readonlyContent = safetyTier === 'readonly';
  const noOverlayPath = !allowLocalOverride;
  const canEditContent = !readonlyContent && !noOverlayPath;

  const actions: Record<SegmentAction, SegmentActionPermission> = {
    edit: {
      allowed: canEditContent,
      reason: canEditContent
        ? null
        : readonlyContent
          ? '当前段 safetyTier=readonly，禁止编辑内容'
          : '当前段无本地覆盖路径，不可编辑',
      reasonCode: canEditContent ? null : readonlyContent ? 'safety-tier-readonly' : 'no-local-overlay-path',
    },
    disable: {
      allowed: disableable && enabled,
      reason: disableable ? (enabled ? null : '当前段已禁用') : '当前段 disableable=false，不可禁用',
      reasonCode: disableable ? (enabled ? null : 'already-disabled') : 'not-disableable',
    },
    enable: {
      allowed: !enabled && hasOverride,
      reason: !enabled && hasOverride ? null : enabled ? '当前段已启用' : '当前段无禁用覆盖可启用',
      reasonCode: !enabled && hasOverride ? null : enabled ? 'already-enabled' : 'no-disable-override',
    },
    rollback: {
      allowed: hasOverride,
      reason: hasOverride ? null : '当前段无覆盖可回滚',
      reasonCode: hasOverride ? null : 'no-override',
    },
    restoreBackup: {
      allowed: hasBackup && canEditContent,
      reason: hasBackup
        ? canEditContent
          ? null
          : readonlyContent
            ? '当前段 safetyTier=readonly，禁止恢复备份'
            : '当前段无本地覆盖路径，不可恢复备份'
        : '当前段无备份文件',
      reasonCode:
        hasBackup && canEditContent
          ? null
          : !hasBackup
            ? 'no-backup'
            : readonlyContent
              ? 'safety-tier-readonly'
              : 'no-local-overlay-path',
    },
    activateVersion: {
      allowed: hasContentOverride && !readonlyContent,
      reason: hasContentOverride
        ? readonlyContent
          ? '当前段 safetyTier=readonly，禁止激活版本'
          : null
        : '当前段无内容覆盖版本可激活',
      reasonCode:
        hasContentOverride && !readonlyContent
          ? null
          : !hasContentOverride
            ? 'no-content-override'
            : 'safety-tier-readonly',
    },
  };

  return {
    segmentId,
    safetyTier,
    allowLocalOverride,
    disableable,
    overrideState: { enabled, hasOverride, hasContentOverride, hasBackup },
    actions,
  };
}

/** Convenience: build matrix from a hook manifest + runtime state. */
export function resolveSegmentEnablementMatrixFromManifest(
  manifest: Pick<HookManifest, 'id' | 'safetyTier' | 'disableable'>,
  allowLocalOverride: boolean,
  overrideState: {
    enabled: boolean;
    hasOverride: boolean;
    hasContentOverride: boolean;
    hasBackup: boolean;
  },
): SegmentEnablementMatrix {
  return resolveSegmentEnablementMatrix({
    segmentId: manifest.id,
    safetyTier: manifest.safetyTier,
    allowLocalOverride,
    disableable: manifest.disableable,
    ...overrideState,
  });
}
