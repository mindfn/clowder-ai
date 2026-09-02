import { memoryUsageBytes } from '../lib/redis.mjs';
import { combine, fail, pass, unbound } from '../lib/report.mjs';
import { collectDrainResidue, diffDerivedKeys, snapshotDerivedKeys } from './derived-keys.mjs';

const KB = 1024;

// S1 declares the CycleRecord key template + read face in its commit message; bind here.
// Until then the size/status parts stay unbound (honest, not green).
export const CYCLE_RECORD_SURFACE = Object.freeze({
  bound: false,
  keyFor: null,
  note: 'bind after S1: CycleRecord key template ({keyPrefix, ownerUserId, objectiveId}) + read route',
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
  if (bytes === null) parts.push(fail('F-2', `CycleRecord missing: ${key}`, { key }));
  else if (bytes >= 64 * KB) parts.push(fail('F-2', `CycleRecord ${bytes} B ≥ 64 KB`, { key, bytes }));
  else parts.push(pass('F-2', `CycleRecord ${bytes} B < 64 KB`, { key, bytes }));
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
