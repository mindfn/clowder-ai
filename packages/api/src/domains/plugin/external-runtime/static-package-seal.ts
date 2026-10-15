import type { BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type TreeIdentity = ReadonlyMap<string, string>;

function identity(stat: BigIntStats): string {
  // atime is intentionally excluded: reading admitted assets does not mutate
  // them. ctime cannot be restored with utimes, unlike mtime. Nanoseconds and
  // inode/device identity also reject equal-size writes and equal-byte swaps.
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(':');
}

async function snapshotIdentity(root: string): Promise<TreeIdentity> {
  const entries = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()))
      throw new Error('static package contains a link or special entry');
    if (path === root && !before.isDirectory()) throw new Error('static package root changed');
    entries.set(path, identity(before));
    if (before.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(resolve(path, name));
      // Detect directory swaps/additions/removals while inspecting children.
      if (identity(await lstat(path, { bigint: true })) !== identity(before))
        throw new Error('static package changed during verification');
    }
  }
  await walk(root);
  return entries;
}

function equal(left: TreeIdentity, right: TreeIdentity): boolean {
  return left.size === right.size && [...left].every(([path, stamp]) => right.get(path) === stamp);
}

/** A private, per-staging-generation proof for static assets already copied into
 * Host-owned Buffers. Never used to admit executable files from disk. The byte
 * proof is bracketed by stable tree identities; every use rechecks that exact
 * identity. No time-based cache, re-sealing after mutation, or authority grant. */
export async function sealStaticPackage(root: string, verifyBytes: () => Promise<void>): Promise<() => Promise<void>> {
  const before = await snapshotIdentity(root);
  await verifyBytes();
  const admitted = await snapshotIdentity(root);
  if (!equal(before, admitted)) throw new Error('static package changed while sealing');
  let damaged = false;
  return async () => {
    if (damaged) throw new Error('static package generation is damaged');
    try {
      if (!equal(admitted, await snapshotIdentity(root))) throw new Error('static package generation changed');
      if (damaged) throw new Error('static package generation is damaged');
    } catch (error) {
      damaged = true;
      throw error;
    }
  };
}
