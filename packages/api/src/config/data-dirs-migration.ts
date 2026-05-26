/**
 * Data directory migration engine — issue #671.
 *
 * When the user sets DATA_DIR / CACHE_DIR / LOG_DIR in their .env and
 * restarts the service, any existing data at the legacy paths must be
 * relocated to the new root before any consumer (SQLite, logger, etc.)
 * opens connections to the new path.
 *
 * Protocol (铲屎官 spec):
 *   1. Probe available space on the target volume
 *   2. Migrate (rename when on the same filesystem; otherwise copy + verify + delete)
 *   3. Failure → log a warning, leave the legacy path untouched
 *   4. Success → cleanup of the legacy file/dir is built into the move
 *      (rename removes the source; cross-volume copy explicitly deletes
 *      after verification). The next read/write goes to the new path
 *      naturally because the resolver only returns the new path when
 *      the root env var is set.
 *   5. Restart-required: this engine runs *before* DB connections open,
 *      so startup migration never needs a restart. Runtime migration
 *      (post-startup, via Settings UI) sets `restartRecommended: true`
 *      in the result so the caller can surface a notice.
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type DataPathKey, type DataPathSpec, describeDataPaths } from './data-dirs.js';

/** SQLite sidecar suffixes that must move alongside the main DB file. */
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];

export interface MigrationPlanItem {
  readonly spec: DataPathSpec;
  /** Bytes that need to move (legacy path size, including SQLite sidecars). */
  readonly sourceBytes: number;
  /** True if the source path exists at all. */
  readonly sourceExists: boolean;
  /** True if the target path is already populated (skip to avoid overwrite). */
  readonly targetPopulated: boolean;
  /** True if this item is eligible for migration. */
  readonly eligible: boolean;
  /** Reason if not eligible. */
  readonly skipReason?: string;
}

export interface MigrationPlan {
  /** All paths in scope — even the ones we won't move. */
  readonly items: readonly MigrationPlanItem[];
  /** Total bytes that will move across all eligible items. */
  readonly totalBytes: number;
  /** True if any item is eligible for migration. */
  readonly hasWork: boolean;
}

export interface MigrationItemResult {
  readonly key: DataPathKey;
  readonly fromPath: string;
  readonly toPath: string;
  readonly bytes: number;
  readonly status: 'moved' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly error?: string;
}

export interface MigrationResult {
  readonly attempted: boolean;
  readonly items: readonly MigrationItemResult[];
  /** True if every eligible item moved successfully. */
  readonly allSucceeded: boolean;
  /** True if the caller should surface a restart notice (runtime migration only). */
  readonly restartRecommended: boolean;
  /** Top-level abort reason, e.g. insufficient disk space. */
  readonly abortedReason?: string;
}

export interface AbortDecision {
  readonly shouldAbort: boolean;
  readonly reason?: string;
  /** Per-path details for the error message (key + which side has data). */
  readonly leftBehind: readonly { readonly key: DataPathKey; readonly fromPath: string; readonly status: string }[];
}

/**
 * Decide whether startup must fail-fast.
 *
 * The hazard: when a root env var is set, the resolver returns the new path
 * unconditionally. If the migration aborted (insufficient space) or any item
 * failed, the legacy data is still at the old path, but consumers will read
 * the new (empty) path — that looks like silent data loss.
 *
 * Returns `{ shouldAbort: true, reason, leftBehind[] }` when:
 *   - The migration aborted at the planning stage (e.g. disk space)
 *   - Any eligible item failed to move
 *
 * Returns `{ shouldAbort: false }` when:
 *   - No migration was attempted (no root set, or no pending work)
 *   - All eligible items moved successfully
 *
 * Skipped items (target-not-empty, no-source-data) do NOT trigger abort:
 *   their legacyPath is irrelevant (no source) or the operator already moved
 *   data manually.
 */
export function shouldAbortStartupOnMigration(result: MigrationResult): AbortDecision {
  if (result.abortedReason) {
    return {
      shouldAbort: true,
      reason: result.abortedReason,
      leftBehind: result.items
        .filter((i) => i.status !== 'moved')
        .map((i) => ({ key: i.key, fromPath: i.fromPath, status: i.status })),
    };
  }
  const failed = result.items.filter((i) => i.status === 'failed');
  if (failed.length > 0) {
    return {
      shouldAbort: true,
      reason: `${failed.length} data-dirs path(s) failed to migrate; legacy data still on disk while resolver now points at the new root`,
      leftBehind: failed.map((i) => ({ key: i.key, fromPath: i.fromPath, status: i.status })),
    };
  }
  return { shouldAbort: false, leftBehind: [] };
}

export interface DiskSpaceProbe {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

/** Pluggable I/O hooks for testing without touching real FS. */
export interface MigrationIO {
  diskFree(path: string): Promise<DiskSpaceProbe>;
  logger?: {
    info: (data: object, msg?: string) => void;
    warn: (data: object, msg?: string) => void;
    error: (data: object, msg?: string) => void;
  };
}

export interface PlanOptions {
  readonly repoRoot: string;
  readonly monorepoRoot: string;
  /** See DescribeOptions.uploadsLegacyOverride — test-only injection. */
  readonly uploadsLegacyOverride?: string;
}

export interface RunOptions extends PlanOptions {
  /** Trigger context — affects restart recommendation in the result. */
  readonly trigger: 'startup' | 'runtime';
  readonly io: MigrationIO;
  /** Skip the disk-space pre-flight (useful for tests). */
  readonly skipSpaceCheck?: boolean;
  /** Multiplier applied to required bytes when checking disk free space. */
  readonly spaceSafetyMultiplier?: number;
}

const DEFAULT_SAFETY_MULTIPLIER = 1.5;

/** Recursively measure on-disk size of a file or directory. */
export async function measurePath(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const st = await stat(path);
  if (st.isFile()) {
    let total = st.size;
    // Include SQLite sidecars if the main file looks like a DB
    if (path.endsWith('.sqlite')) {
      for (const suffix of SQLITE_SIDECARS) {
        const sidecar = `${path}${suffix}`;
        if (existsSync(sidecar)) {
          const ss = await stat(sidecar);
          total += ss.size;
        }
      }
    }
    return total;
  }
  if (st.isDirectory()) {
    let total = 0;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      total += await measurePath(join(path, entry.name));
    }
    return total;
  }
  return 0;
}

/**
 * Build a migration plan describing what would move and why.
 * Pure — does not touch the filesystem beyond stat/readdir calls.
 *
 * `logs` is intentionally excluded — Pino captures LOG_DIR at module load,
 * so moving logs without a logger restart is unsafe. Setting LOG_DIR only
 * redirects future writes; legacy logs remain at the old path.
 */
export async function buildMigrationPlan(opts: PlanOptions): Promise<MigrationPlan> {
  const specs = describeDataPaths(opts).filter((s) => s.key !== 'logs');
  const items: MigrationPlanItem[] = [];
  let totalBytes = 0;

  for (const spec of specs) {
    // Only consider entries where a root is configured and legacy != root path.
    if (spec.rootBasedPath === null) {
      items.push({
        spec,
        sourceBytes: 0,
        sourceExists: false,
        targetPopulated: false,
        eligible: false,
        skipReason: 'root-env-not-set',
      });
      continue;
    }

    if (spec.legacyPath === spec.rootBasedPath) {
      items.push({
        spec,
        sourceBytes: 0,
        sourceExists: false,
        targetPopulated: false,
        eligible: false,
        skipReason: 'legacy-equals-target',
      });
      continue;
    }

    const sourceExists = existsSync(spec.legacyPath);
    const targetPopulated = existsSync(spec.rootBasedPath) && (await isPopulated(spec.rootBasedPath));

    if (!sourceExists) {
      items.push({
        spec,
        sourceBytes: 0,
        sourceExists: false,
        targetPopulated,
        eligible: false,
        skipReason: 'no-source-data',
      });
      continue;
    }

    if (targetPopulated) {
      items.push({
        spec,
        sourceBytes: 0,
        sourceExists: true,
        targetPopulated: true,
        eligible: false,
        skipReason: 'target-not-empty',
      });
      continue;
    }

    const sourceBytes = await measurePath(spec.legacyPath);
    items.push({
      spec,
      sourceBytes,
      sourceExists: true,
      targetPopulated: false,
      eligible: true,
    });
    totalBytes += sourceBytes;
  }

  const hasWork = items.some((i) => i.eligible);
  return { items, totalBytes, hasWork };
}

async function isPopulated(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (st.isFile()) return st.size > 0;
    if (st.isDirectory()) {
      const entries = await readdir(path);
      return entries.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Execute the migration plan with the configured safety guards.
 * On insufficient disk space, returns `attempted: false` and a reason — no
 * partial moves happen. On per-item failure, the item is left at the legacy
 * path and other items continue to migrate independently.
 */
export async function runDataDirsMigration(opts: RunOptions): Promise<MigrationResult> {
  const log = opts.io.logger;
  const plan = await buildMigrationPlan(opts);

  if (!plan.hasWork) {
    log?.info({ trigger: opts.trigger }, '[#671] No data-dirs migration pending');
    return {
      attempted: false,
      items: [],
      allSucceeded: true,
      restartRecommended: false,
    };
  }

  // Group eligible items by their target root mountpoint for space check.
  const eligible = plan.items.filter((i) => i.eligible);

  if (!opts.skipSpaceCheck) {
    const safetyMul = opts.spaceSafetyMultiplier ?? DEFAULT_SAFETY_MULTIPLIER;
    const byTarget = new Map<string, number>();
    for (const item of eligible) {
      const targetRoot = item.spec.rootBasedPath!;
      const bucket = targetMountKey(targetRoot);
      byTarget.set(bucket, (byTarget.get(bucket) ?? 0) + item.sourceBytes);
    }

    for (const [bucketPath, requiredBytes] of byTarget) {
      const probe = await opts.io.diskFree(bucketPath);
      const need = Math.ceil(requiredBytes * safetyMul);
      if (probe.availableBytes < need) {
        log?.warn(
          {
            bucket: bucketPath,
            requiredBytes: need,
            availableBytes: probe.availableBytes,
            trigger: opts.trigger,
          },
          '[#671] Insufficient disk space for data-dirs migration — aborting',
        );
        return {
          attempted: false,
          items: [],
          allSucceeded: false,
          restartRecommended: false,
          abortedReason: `insufficient-disk-space: need ${need} bytes at ${bucketPath}, have ${probe.availableBytes}`,
        };
      }
    }
  }

  const results: MigrationItemResult[] = [];
  for (const item of plan.items) {
    if (!item.eligible) {
      results.push({
        key: item.spec.key,
        fromPath: item.spec.legacyPath,
        toPath: item.spec.rootBasedPath ?? item.spec.legacyPath,
        bytes: 0,
        status: 'skipped',
        reason: item.skipReason,
      });
      continue;
    }
    try {
      await migrateOne(item.spec, item.spec.isFile);
      log?.info(
        {
          key: item.spec.key,
          from: item.spec.legacyPath,
          to: item.spec.rootBasedPath,
          bytes: item.sourceBytes,
        },
        '[#671] Migrated data-dirs entry',
      );
      results.push({
        key: item.spec.key,
        fromPath: item.spec.legacyPath,
        toPath: item.spec.rootBasedPath!,
        bytes: item.sourceBytes,
        status: 'moved',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.warn(
        {
          key: item.spec.key,
          from: item.spec.legacyPath,
          to: item.spec.rootBasedPath,
          error: message,
          trigger: opts.trigger,
        },
        '[#671] Migration failed for data-dirs entry — legacy path left intact',
      );
      results.push({
        key: item.spec.key,
        fromPath: item.spec.legacyPath,
        toPath: item.spec.rootBasedPath!,
        bytes: item.sourceBytes,
        status: 'failed',
        error: message,
      });
    }
  }

  const movedAny = results.some((r) => r.status === 'moved');
  const allEligibleSucceeded = eligible.every((item) =>
    results.find((r) => r.key === item.spec.key && r.status === 'moved'),
  );

  return {
    attempted: true,
    items: results,
    allSucceeded: allEligibleSucceeded,
    restartRecommended: opts.trigger === 'runtime' && movedAny,
  };
}

/** Migrate a single path (file or directory) with SQLite sidecar handling. */
async function migrateOne(spec: DataPathSpec, isFile: boolean): Promise<void> {
  const target = spec.rootBasedPath!;
  await mkdir(dirname(target), { recursive: true });

  if (isFile) {
    await moveFile(spec.legacyPath, target);
    // Move SQLite sidecars alongside
    for (const suffix of SQLITE_SIDECARS) {
      const sidecarSrc = `${spec.legacyPath}${suffix}`;
      if (existsSync(sidecarSrc)) {
        await moveFile(sidecarSrc, `${target}${suffix}`);
      }
    }
    return;
  }

  await moveTree(spec.legacyPath, target);
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if (!isCrossDeviceError(err)) throw err;
  }
  // Cross-device fallback: copy → verify hash → delete source
  await copyFile(from, to);
  const srcHash = await hashFile(from);
  const dstHash = await hashFile(to);
  if (srcHash !== dstHash) {
    await unlink(to).catch(() => {});
    throw new Error(`Hash mismatch after copy: ${from} → ${to}`);
  }
  await unlink(from);
}

async function moveTree(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if (!isCrossDeviceError(err)) throw err;
  }
  // Cross-device fallback: recursive copy → spot-check sizes → recursive delete
  await copyTree(from, to);
  // Best-effort verification: compare total sizes (deep hash would be expensive)
  const srcSize = await measurePath(from);
  const dstSize = await measurePath(to);
  if (srcSize !== dstSize) {
    await rm(to, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Size mismatch after tree copy: ${from} (${srcSize}) → ${to} (${dstSize})`);
  }
  await rm(from, { recursive: true, force: true });
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst);
    } else if (entry.isFile()) {
      await copyFile(src, dst);
    }
    // Symlinks/special files: best-effort skip
  }
}

async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', rejectHash);
  });
}

function isCrossDeviceError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EXDEV';
}

/** Choose a stable bucket key for grouping items by target volume. */
function targetMountKey(targetPath: string): string {
  // Walk up to find an existing ancestor — that's where free space lives.
  let cursor = targetPath;
  while (cursor !== dirname(cursor)) {
    if (existsSync(cursor)) return cursor;
    cursor = dirname(cursor);
  }
  return cursor;
}

/** Default disk-free probe using statfs (Node 18.15+). */
export const defaultDiskSpaceProbe: MigrationIO['diskFree'] = async (path: string) => {
  // Find a path that exists to call statfs on (statfs fails on missing path)
  let cursor = path;
  while (!existsSync(cursor) && cursor !== dirname(cursor)) {
    cursor = dirname(cursor);
  }
  // statfs is available since Node 18.15 — fall back to a generous estimate if missing
  try {
    const fsPromises = await import('node:fs/promises');
    const statfsFn = (
      fsPromises as unknown as { statfs?: (p: string) => Promise<{ bavail: bigint; blocks: bigint; bsize: number }> }
    ).statfs;
    if (typeof statfsFn === 'function') {
      const result = await statfsFn(cursor);
      const blockSize = result.bsize;
      return {
        availableBytes: Number(result.bavail) * blockSize,
        totalBytes: Number(result.blocks) * blockSize,
      };
    }
  } catch {
    /* fall through to synchronous statSync — yields no space info */
  }

  // Last-ditch fallback: pretend we have plenty of space (don't block migration on probe failure)
  void statSync(cursor); // throw if the path is invalid
  return { availableBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER };
};
