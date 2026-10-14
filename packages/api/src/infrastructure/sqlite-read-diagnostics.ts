import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface SqliteReadDiagnostic {
  databasePath: string;
  sqlFingerprint: string;
  caller: string[];
  requestId: string | null;
  startedAt: number;
  elapsedMs: number;
  rows: number | null;
}

export interface SqliteReadDiagnosticOptions {
  onSlowRead: (event: SqliteReadDiagnostic) => void;
  minDurationMs?: number;
  maxReports?: number;
  maxPerCallsite?: number;
  getRequestId?: () => string | null;
  clock?: () => number;
}

/** Bounded native-read witnesses. Binding values, SQL text and row contents never reach the sink. */
export function createSqliteReadDiagnostics(
  options: SqliteReadDiagnosticOptions,
): (db: Database.Database) => () => void {
  const minDurationMs = options.minDurationMs ?? 100;
  const maxReports = options.maxReports ?? 20;
  const maxPerCallsite = options.maxPerCallsite ?? 2;
  const clock = options.clock ?? (() => performance.now());
  const seen = new Map<string, number>();
  const attached = new WeakMap<Database.Database, () => void>();
  const fingerprints = new WeakMap<Database.Statement, string>();
  let reports = 0;

  function recordSlowRead(
    db: Database.Database,
    statement: Database.Statement,
    rows: number | null,
    startedAt: number,
    elapsedMs: number,
  ) {
    if (elapsedMs < minDurationMs || reports >= maxReports) return;
    const fingerprint = fingerprints.get(statement) ?? createHash('sha256').update(statement.source).digest('hex');
    fingerprints.set(statement, fingerprint);
    const caller = (new Error().stack ?? '').split('\n').slice(3, 11);
    const key = `${fingerprint}\n${caller.join('\n')}`;
    const count = seen.get(key) ?? 0;
    if (count >= maxPerCallsite) return;
    seen.set(key, count + 1);
    reports++;
    options.onSlowRead({
      databasePath: db.name,
      sqlFingerprint: fingerprint,
      caller,
      requestId: options.getRequestId?.() ?? null,
      startedAt,
      elapsedMs,
      rows,
    });
  }

  return (db) => {
    const existing = attached.get(db);
    if (existing) return existing;
    const originalPrepare = db.prepare;
    let active = true;
    const observedPrepare = new Proxy(originalPrepare, {
      apply(prepare, receiver, argumentsList) {
        const statement = Reflect.apply(prepare, receiver, argumentsList) as Database.Statement;
        statement.all = new Proxy(statement.all, {
          apply(all, statementReceiver, bindings) {
            if (!active || reports >= maxReports) return Reflect.apply(all, statementReceiver, bindings);
            const startedAt = Date.now();
            const start = clock();
            let rows: number | null = null;
            try {
              const result: unknown = Reflect.apply(all, statementReceiver, bindings);
              if (Array.isArray(result)) rows = result.length;
              return result;
            } finally {
              // Observability must never replace a native result or exception, including when its sink is down.
              try {
                recordSlowRead(db, statement, rows, startedAt, clock() - start);
              } catch {
                /* Keep the original SQLite result/error authoritative. */
              }
            }
          },
        });
        return statement;
      },
    });
    db.prepare = observedPrepare;
    const stop = () => {
      active = false;
      if (db.prepare === observedPrepare) db.prepare = originalPrepare;
      attached.delete(db);
    };
    attached.set(db, stop);
    return stop;
  };
}
