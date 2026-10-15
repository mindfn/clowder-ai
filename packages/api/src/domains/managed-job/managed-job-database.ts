import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';

export function openSupervisorStore(job: DurableManagedGateJob): Database.Database {
  const directory = dirname(job.recordPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new Database(join(directory, 'supervisor.sqlite'));
  chmodSync(join(directory, 'supervisor.sqlite'), 0o600);
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_gate_supervisors (
      job_id TEXT PRIMARY KEY,
      supervisor_epoch TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      lease_until INTEGER NOT NULL,
      supervisor_pid INTEGER NOT NULL,
      supervisor_ppid INTEGER NOT NULL,
      supervisor_pgid INTEGER NOT NULL,
      supervisor_started_at TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const columns = new Set(
    (database.prepare('PRAGMA table_info(durable_gate_supervisors)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const migrations = [
    ['supervisor_pid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_ppid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_pgid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_started_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of migrations) {
    if (columns.has(name)) continue;
    try {
      database.exec(`ALTER TABLE durable_gate_supervisors ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      const migratedByPeer = (
        database.prepare('PRAGMA table_info(durable_gate_supervisors)').all() as Array<{ name: string }>
      ).some((column) => column.name === name);
      if (!migratedByPeer) throw error;
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_jobs (
      job_id TEXT PRIMARY KEY,
      principal_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      UNIQUE(principal_key, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS managed_job_transitions (
      job_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      supervisor_epoch TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      state TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(job_id, revision)
    );
    CREATE INDEX IF NOT EXISTS managed_jobs_owner_state ON managed_jobs (
      json_extract(record_json, '$.descriptor.definition.principal.userId'),
      json_extract(record_json, '$.descriptor.definition.principal.catId'), state
    );
  `);
  return database;
}

export function transaction<T>(database: Database.Database, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
