import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V27 migration — recall_events result_status', () => {
  it('adds nullable result_status for structured recall outcome state', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(schema.SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
      schema.applyMigrations(db);

      const cols = db.prepare("PRAGMA table_info('recall_events')").all();
      const resultStatus = cols.find((col) => col.name === 'result_status');
      assert.ok(resultStatus, 'result_status column exists');
      assert.equal(resultStatus.notnull, 0, 'result_status is nullable so old rows can stay legacy_unknown');
      assert.ok(schema.CURRENT_SCHEMA_VERSION >= 27);
    } finally {
      db.close();
    }
  });

  it('repairs missing recall columns even when the migration ledger is already newer', async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    try {
      schema.applyMigrations(db);
      const columns = db
        .prepare("PRAGMA table_info('recall_events')")
        .all()
        .map((column) => column.name)
        .filter((name) => !['thread_id', 'result_count', 'result_status'].includes(name));
      db.exec('ALTER TABLE recall_events RENAME TO recall_events_before_repair');
      db.exec(`CREATE TABLE recall_events AS SELECT ${columns.map((name) => `"${name}"`).join(', ')}
               FROM recall_events_before_repair`);
      db.exec('DROP TABLE recall_events_before_repair');
      const damaged = db.prepare("PRAGMA table_info('recall_events')").all();
      assert.equal(
        damaged.some((column) => ['thread_id', 'result_count', 'result_status'].includes(column.name)),
        false,
      );
      assert.equal(
        db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
        schema.CURRENT_SCHEMA_VERSION,
      );

      schema.applyMigrations(db);

      const repaired = db.prepare("PRAGMA table_info('recall_events')").all();
      for (const name of ['thread_id', 'result_count', 'result_status']) {
        assert.ok(
          repaired.some((column) => column.name === name),
          `${name} is repaired`,
        );
      }
      assert.doesNotThrow(() =>
        db.prepare('SELECT result_count, result_status, thread_id FROM recall_events LIMIT 1').all(),
      );
      assert.doesNotThrow(() => schema.applyMigrations(db));
    } finally {
      db.close();
    }
  });
});
