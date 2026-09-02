import { memoryUsageBytes, readJsonKey } from '../lib/redis.mjs';
import { combine, fail, pass, unbound } from '../lib/report.mjs';
import { collectDrainResidue, diffDerivedKeys, snapshotDerivedKeys } from './derived-keys.mjs';

const KB = 1024;
// complete-design-v1 §2 CycleRecord schema (S1 adds schemaVersion/cycleId/ownerUserId/objectiveId/triggeredBy).
const CYCLE_RECORD_FIELDS = new Set([
  'schemaVersion',
  'cycleId',
  'ownerUserId',
  'objectiveId',
  'version',
  'versionContentRef',
  'cycleStart',
  'cycleEnd',
  'evalStatus',
  'windows',
  'triggeredBy',
  'evaluation',
  'governance',
  'approval',
  'closedAt',
  // S2 (0a96514fd5614) delivery / bounded-retrigger observability fields (TC-7): ids + timestamps only.
  'assignmentThreadId',
  'assignmentMessageId',
  'assignedAt',
  'retriggerMessageId',
  'retriggeredAt',
  'stalledAlertMessageId',
  'stalledAt',
]);

// S1 declares the CycleRecord key template + read face in its commit message; bind here.
// Until then the size/status parts stay unbound (honest, not green).
export const CYCLE_RECORD_SURFACE = Object.freeze({
  bound: true,
  // S1 @ 9c5a7148b: CycleRecordStore.ts key templates (owner/objective scoped).
  keyFor: ({ keyPrefix, ownerUserId, objectiveId }) =>
    `${keyPrefix}harness-cycle-current:${ownerUserId}:${objectiveId}`,
  historyIndexFor: ({ keyPrefix, ownerUserId, objectiveId }) =>
    `${keyPrefix}harness-cycle-history-index:${ownerUserId}:${objectiveId}`,
  historyFor: ({ keyPrefix, ownerUserId, objectiveId, cycleId }) =>
    `${keyPrefix}harness-cycle-history:${ownerUserId}:${objectiveId}:${cycleId}`,
  note: 'bound to S1 CycleRecordStore (harness-cycle-current / -history / -history-index)',
});

export async function checkF2({ redis, keyPrefix, ownerUserId, objectiveId, baseline }) {
  const parts = [];
  const current = await snapshotDerivedKeys(redis, keyPrefix);
  const diff = diffDerivedKeys(baseline, current);
  parts.push(
    diff.addedCount === 0
      ? pass('F-2', 'no derived-state keys regrew since baseline', { baselineAt: baseline.capturedAt })
      : fail('F-2', `${diff.addedCount} derived-state keys regrew since baseline`, diff.added),
  );
  if (!CYCLE_RECORD_SURFACE.bound) {
    parts.push(unbound('F-2', 'CycleRecord size: surface not bound (S1)', { note: CYCLE_RECORD_SURFACE.note }));
    return combine('F-2', parts);
  }
  const key = CYCLE_RECORD_SURFACE.keyFor({ keyPrefix, ownerUserId, objectiveId });
  const bytes = await memoryUsageBytes(redis, key);
  const record = await readJsonKey(redis, key);
  if (bytes === null || !record) parts.push(fail('F-2', `CycleRecord missing: ${key}`, { key }));
  else {
    const limit = ['idle', 'requested'].includes(record.evalStatus) ? KB : 64 * KB;
    const bodyFields = Object.keys(record).filter((field) => !CYCLE_RECORD_FIELDS.has(field));
    if (bytes >= limit)
      parts.push(fail('F-2', `CycleRecord ${bytes} B ≥ ${limit} B (${record.evalStatus})`, { key, bytes }));
    else if (bodyFields.length > 0)
      parts.push(fail('F-2', `CycleRecord carries non-schema fields: ${bodyFields.join(',')}`));
    else parts.push(pass('F-2', `CycleRecord ${bytes} B (${record.evalStatus}), refs only`, { key, bytes }));
  }
  return combine('F-2', parts);
}

export async function checkF3({ redis, keyPrefix, ownerUserId }) {
  const residue = await collectDrainResidue(redis, keyPrefix, ownerUserId);
  const leftovers = [];
  if (residue.sweepState) leftovers.push(`sweep drain state ${residue.sweepState}`);
  if (residue.retryDue) leftovers.push('sweep retry-due membership');
  if (residue.unitJobs.length > 0) leftovers.push(`${residue.unitJobs.length} live unit jobs`);
  const parts = [
    leftovers.length === 0
      ? pass('F-3', 'no drain/lease residue')
      : fail('F-3', `drain/lease residue: ${leftovers.join(', ')}`, residue),
    unbound('F-3', 'bounded retrigger (exactly 1, then stalled): surface not bound (S2 thread + evalStatus)'),
  ];
  return combine('F-3', parts);
}
