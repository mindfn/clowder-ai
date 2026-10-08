import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TranscriptEvent } from '../TranscriptReader.js';
import { InvocationSummaryAccumulator } from './InvocationSummaryAccumulator.js';
import { TRANSCRIPT_INVOCATION_PROJECTION_VERSION } from './transcript-invocation-index-schema.js';
import type { InvocationIndexDiagnostics, SessionIndexInput } from './transcript-invocation-index-types.js';
import { orderedTranscriptMergeSql } from './transcript-ordered-merge.js';

/** Counted overlaps retain source positions, materialized without full payloads. */
export function updateCanonicalInvocationIndex(
  db: Database.Database,
  input: SessionIndexInput,
  signatures: string[],
  diagnostics: InvocationIndexDiagnostics,
): void {
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify([
        TRANSCRIPT_INVOCATION_PROJECTION_VERSION,
        'ordered-overlap-v2',
        input.session,
        input.includeLive,
        signatures,
        input.buffered.map((event) => [event.hash, event.projection.eventNo]),
      ]),
    )
    .digest('hex');
  const cached = db.prepare('SELECT key FROM cache WHERE id = 1').get() as { key: string } | undefined;
  if (cached?.key === cacheKey) {
    diagnostics.summaryCacheHits += 1;
    return;
  }
  db.exec(`CREATE TEMP TABLE buffer AS SELECT * FROM source_events WHERE 0`);
  const insertBuffer = db.prepare(`INSERT INTO buffer
    (source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection, files_touched)
    VALUES (2, ?, ?, ?, ?, 0, 0, ?, ?)`);
  for (let index = 0; index < input.buffered.length; index += 1) {
    const event = input.buffered[index];
    if (event)
      insertBuffer.run(
        index,
        event.projection.eventNo,
        event.projection.invocationId ?? null,
        event.hash,
        JSON.stringify(event.projection),
        JSON.stringify(event.filesTouched),
      );
  }
  db.exec(`CREATE TEMP TABLE active AS ${orderedTranscriptMergeSql(
    `SELECT *, seq AS order_no FROM source_events WHERE source = 1 AND ${input.includeLive ? 1 : 0}`,
    'SELECT *, seq AS order_no FROM buffer',
    true,
  )};
    CREATE INDEX active_hash ON active(hash);
    DELETE FROM canonical;
  `);
  const activeCount = (db.prepare('SELECT COUNT(*) AS count FROM active').get() as { count: number }).count;
  if (activeCount === 0) {
    db.exec(`INSERT INTO canonical
      SELECT seq, source, seq, event_no, invocation_id, byte_offset, byte_length, projection
      FROM source_events WHERE source = 0 ORDER BY seq`);
  } else {
    db.exec(`INSERT INTO canonical
      SELECT merge_no, source, seq, merge_no, invocation_id, byte_offset, byte_length, projection
      FROM (${orderedTranscriptMergeSql(
        'SELECT *, seq AS order_no FROM source_events WHERE source = 0',
        'SELECT *, merge_no AS order_no FROM active',
      )}) ORDER BY merge_no`);
  }
  const accumulator = new InvocationSummaryAccumulator(input.session);
  for (const row of db.prepare('SELECT projection, event_no FROM canonical ORDER BY logical_no').iterate() as Iterable<{
    projection: string;
    event_no: number;
  }>) {
    accumulator.add({ ...(JSON.parse(row.projection) as TranscriptEvent), eventNo: row.event_no });
  }
  db.exec('DELETE FROM summaries');
  const insert = db.prepare('INSERT INTO summaries VALUES (?, ?, ?)');
  for (const summary of accumulator.values())
    insert.run(summary.invocationId, summary.startedAt, JSON.stringify(summary));
  db.prepare('INSERT OR REPLACE INTO cache VALUES (1, ?)').run(cacheKey);
}
