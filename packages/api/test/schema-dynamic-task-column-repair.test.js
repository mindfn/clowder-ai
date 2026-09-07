/**
 * A schema_version number is a claim about history. This repairs the case where that claim is
 * false.
 *
 * Two independent lines both numbered a `dynamic_task_defs` migration 40: this fork's added
 * `retry_attempts` (3b4e71c25, 2026-09-02) and upstream's added
 * `entrusted_work_reevaluation_json` (9f6ac2069, the 2026-09-03 sync). A database that ran the
 * fork's V40 recorded version 40, so when the sync swapped the code in, the upstream V40 body was
 * already considered applied and never ran — while `DynamicTaskStore` writes that column
 * unconditionally. Every dynamic task insert then failed, which is what took `hold_ball` down
 * with "table dynamic_task_defs has no column named entrusted_work_reevaluation_json".
 *
 * Renumbering the fork migration to V42 fixed FRESH databases and cannot fix one that already
 * recorded 40. So the repair asks the table which columns exist instead of asking schema_version
 * what it believes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

const { applyMigrations } = await import('../dist/domains/memory/schema.js');

function columnsOf(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
}

/**
 * Produces the exact production state: the version counter is fully advanced, yet the column the
 * skipped migration owned is absent. Dropping it after a healthy migrate reproduces that more
 * honestly than hand-building a table, because everything else stays whatever the real schema is.
 */
function collidedDatabase() {
  const db = new Database(':memory:');
  applyMigrations(db);
  db.exec('ALTER TABLE dynamic_task_defs DROP COLUMN entrusted_work_reevaluation_json');
  return db;
}

describe('dynamic_task_defs column repair (fork/upstream V40 collision)', () => {
  it('restores a column whose migration was skipped by a colliding version number', () => {
    const db = collidedDatabase();
    assert.equal(
      columnsOf(db, 'dynamic_task_defs').has('entrusted_work_reevaluation_json'),
      false,
      'precondition: the collided database is missing the column',
    );
    const claimedVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get().v;

    applyMigrations(db);

    assert.ok(
      columnsOf(db, 'dynamic_task_defs').has('entrusted_work_reevaluation_json'),
      'a version number that already passed 40 must not be able to strand the column forever',
    );
    assert.equal(
      db.prepare('SELECT MAX(version) as v FROM schema_version').get().v,
      claimedVersion,
      'and it records no version row: converging to the declared shape is not a history event',
    );
  });

  it('repairs the mirror case too — the fork column stranded on an upstream-first database', () => {
    // The collision is symmetric: whichever line's V40 ran first, the other one is skipped.
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('ALTER TABLE dynamic_task_defs DROP COLUMN retry_attempts');

    applyMigrations(db);

    assert.ok(columnsOf(db, 'dynamic_task_defs').has('retry_attempts'));
  });

  it('the repaired table accepts the write that was failing in production', () => {
    const db = collidedDatabase();
    applyMigrations(db);

    // This is the statement DynamicTaskStore issues; it names the column unconditionally.
    db.prepare(
      `INSERT INTO dynamic_task_defs
         (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json,
          display_json, delivery_thread_id, enabled, created_by, created_at, retry_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('task_1', 'tpl', '{}', '{}', null, '{}', 'thread_1', 1, 'opus', new Date().toISOString(), 0);

    assert.equal(db.prepare('SELECT COUNT(*) as n FROM dynamic_task_defs').get().n, 1);
  });

  it('tolerates a partial schema that never created the table at all', () => {
    // Callers exist that seed a few tables and jump schema_version forward to exercise one
    // migration. PRAGMA table_info answers for a missing table with an empty list, so a column
    // check alone would happily try to ALTER a table that was never created.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(42, new Date().toISOString());

    assert.doesNotThrow(() => applyMigrations(db));
  });

  // It DOES run on every startup — that is the point. What it must not do is change anything.
  it('is idempotent on a healthy database and advances no version', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const settledVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get().v;

    applyMigrations(db);

    assert.equal(
      db.prepare('SELECT MAX(version) as v FROM schema_version').get().v,
      settledVersion,
      'an already-migrated database stays put',
    );
    const both = columnsOf(db, 'dynamic_task_defs');
    assert.ok(both.has('entrusted_work_reevaluation_json') && both.has('retry_attempts'));
  });
});
