import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  findOwnedUnixProcesses,
  readCliProcessOwnerRecords,
  readUnixProcessSnapshotSync,
  resolveCatCafeDataRoot,
  sameUnixProcess,
  type UnixProcessIdentity,
} from '../../../../../../utils/cli-process-ownership.js';
import { AGY_NATIVE_CREDENTIAL_DIR } from './agy-native-credential-file.js';

interface ProfileTurnOwner {
  readonly identity: UnixProcessIdentity;
  readonly dataRoot: string;
  readonly invocationId?: string;
}

export class AgyNativeProfileBusyError extends Error {}

/** Mutable provider config is serialized; an occupied account is not a failed chat. */
export async function waitForAgyNativeProfileTurn(
  home: string,
  invocationId?: string,
  signal?: AbortSignal,
): Promise<() => void> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return acquireAgyNativeProfileTurn(home, invocationId);
    } catch (error) {
      if (!(error instanceof AgyNativeProfileBusyError)) throw error;
      await delay(250, undefined, { signal });
    }
  }
}

function isRetired(owner: ProfileTurnOwner, home: string): boolean {
  const snapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
  if (!snapshot || sameUnixProcess(owner.identity, snapshot.get(owner.identity.pid))) return false;
  // The API may have died while its supervised provider tree is still draining.
  const records = readCliProcessOwnerRecords(owner.dataRoot);
  if (records.invalidPaths.length) return false;
  if (
    records.records.some(
      ({ manifest }) =>
        Boolean(owner.invocationId) &&
        manifest.execution?.invocationId === owner.invocationId &&
        findOwnedUnixProcesses(snapshot, manifest.ownerId).length > 0,
    )
  )
    return false;
  const marker = `HOME=${home}`;
  return ![...snapshot.values()].some((entry) => {
    const environment = entry.commandAndEnvironment ?? '';
    const start = environment.indexOf(marker);
    return (
      start >= 0 &&
      (start === 0 || /\s/.test(environment[start - 1] ?? '')) &&
      (start + marker.length === environment.length || /\s/.test(environment[start + marker.length] ?? ''))
    );
  });
}

function retireOrphanCredentials(home: string): void {
  const directory = join(home, '.gemini/config', AGY_NATIVE_CREDENTIAL_DIR);
  let files: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native credential directory is unsafe');
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native orphan credential is not a regular host file');
    rmSync(path);
  }
}

/** One mutable CLI profile has one live turn, including across service/API instances. */
export function acquireAgyNativeProfileTurn(home: string, invocationId?: string): () => void {
  const identity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  if (!identity) throw new Error('Native profile ownership requires a verified process birth identity');
  const path = join(home, '.cat-cafe-native-turn.sqlite');
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Native profile lease is not a regular host file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  const token = randomUUID();
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS native_profile_turn (slot INTEGER PRIMARY KEY CHECK(slot = 1), token TEXT NOT NULL, owner TEXT NOT NULL)',
    );
    db.transaction(() => {
      const previous = db.prepare('SELECT owner FROM native_profile_turn WHERE slot = 1').get() as
        | { owner: string }
        | undefined;
      if (previous) {
        const owner = JSON.parse(previous.owner) as ProfileTurnOwner;
        if (!owner.identity?.startedAt || !Number.isSafeInteger(owner.identity.pid) || !owner.dataRoot)
          throw new Error('Native profile lease has invalid ownership evidence');
        if (!isRetired(owner, home))
          throw new AgyNativeProfileBusyError('Another native turn still owns this isolated profile');
        // Death and absence of descendants are proven under the same transaction
        // that fences the successor. Never retire a live turn's MCP credential.
        retireOrphanCredentials(home);
      }
      const owner: ProfileTurnOwner = {
        identity,
        dataRoot: resolveCatCafeDataRoot(),
        ...(invocationId ? { invocationId } : {}),
      };
      db.prepare(
        'INSERT INTO native_profile_turn (slot, token, owner) VALUES (1, ?, ?) ON CONFLICT(slot) DO UPDATE SET token = excluded.token, owner = excluded.owner',
      ).run(token, JSON.stringify(owner));
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.prepare('DELETE FROM native_profile_turn WHERE slot = 1 AND token = ?').run(token);
    } finally {
      db.close();
    }
  };
}
