import { escapeRedisGlob, readJsonKey, scanKeys } from '../lib/redis.mjs';

// Same target set as scripts/f257-s0-clean-derived-state.mjs (S0). After S0 + S1 none of
// these may regrow: their writers are deleted per complete-design-v1 §6 / §14 S1.
export const DERIVED_PREFIXES = Object.freeze({
  pendingRun: 'harness-unit-run-pending:',
  snapshot: 'harness-evaluation-snapshot:',
  snapshotIndex: 'harness-evaluation-snapshot-index:',
  semanticResult: 'harness-unit-semantic-result:',
  unitJob: 'harness-unit-semantic-job:',
  unitReceipt: 'harness-unit-semantic-retrieval:',
  unitCompletion: 'harness-unit-semantic-completion:',
  sweepJob: 'harness-semantic-sweep-job:',
  sweepCompletion: 'harness-semantic-sweep-completion:',
  sweepState: 'harness-semantic-sweep-state:',
});
export const SWEEP_RETRY_DUE = 'harness-semantic-sweep-retry-due';

export async function snapshotDerivedKeys(redis, keyPrefix) {
  const keys = {};
  for (const [name, prefix] of Object.entries(DERIVED_PREFIXES)) {
    keys[name] = await scanKeys(redis, `${escapeRedisGlob(keyPrefix + prefix)}*`);
  }
  const retryDueMembers = await redis.zrange(`${keyPrefix}${SWEEP_RETRY_DUE}`, 0, -1);
  return { capturedAt: Date.now(), keyPrefix, keys, retryDueMembers: [...retryDueMembers].sort() };
}

export function diffDerivedKeys(baseline, current) {
  const added = {};
  let addedCount = 0;
  for (const name of Object.keys(DERIVED_PREFIXES)) {
    const before = new Set(baseline.keys?.[name] ?? []);
    const fresh = (current.keys?.[name] ?? []).filter((key) => !before.has(key));
    if (fresh.length > 0) {
      added[name] = fresh;
      addedCount += fresh.length;
    }
  }
  return { added, addedCount };
}

/** Owner-scoped drain/lease residue: sweep drain state, retry-due membership, live unit jobs. */
export async function collectDrainResidue(redis, keyPrefix, ownerUserId) {
  const sweepStateKey = `${keyPrefix}${DERIVED_PREFIXES.sweepState}${ownerUserId}`;
  const sweepState = (await redis.exists(sweepStateKey)) === 1 ? sweepStateKey : null;
  const retryDue = (await redis.zscore(`${keyPrefix}${SWEEP_RETRY_DUE}`, ownerUserId)) !== null;
  const unitJobs = [];
  for (const key of await scanKeys(redis, `${escapeRedisGlob(keyPrefix + DERIVED_PREFIXES.unitJob)}*`)) {
    const job = await readJsonKey(redis, key);
    if (job && job.ownerUserId === ownerUserId) unitJobs.push(key);
  }
  return { sweepState, retryDue, unitJobs };
}
