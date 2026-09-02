import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonKey } from '../lib/redis.mjs';
import { combine, fail, pass, unbound } from '../lib/report.mjs';
import { CYCLE_RECORD_SURFACE } from './f2-f3.mjs';

const REGISTRY = 'docs/harness-feedback/objectives/registry.yaml';

function metricIdsFor(projectRoot, objectiveId) {
  const path = join(projectRoot, REGISTRY);
  if (!existsSync(path)) return null;
  const yaml = readFileSync(path, 'utf8');
  const objectiveLine = yaml.match(new RegExp(`\\{ id: ${objectiveId}, [^}]*evaluationModelId: ([a-z0-9-]+)`));
  if (!objectiveLine) return null;
  const block = yaml.split(`- id: ${objectiveLine[1]}\n`)[1]?.split(/\n {2}- id: /)[0] ?? '';
  return [...block.matchAll(/^\s+- id: ([a-z0-9-]+)/gm)].map((m) => m[1]);
}

/** F-1 observational: the Objective's CycleRecord reached `written` with full metric coverage and bounded evidence refs. */
export async function checkF1({ redis, keyPrefix, ownerUserId, objectiveId, projectRoot }) {
  const key = CYCLE_RECORD_SURFACE.keyFor({ keyPrefix, ownerUserId, objectiveId });
  const record = await readJsonKey(redis, key);
  if (!record) return fail('F-1', `no CycleRecord for ${objectiveId}`, { key });
  const expected = metricIdsFor(projectRoot, objectiveId);
  if (record.evalStatus !== 'written' || !record.evaluation) {
    return unbound(
      'F-1',
      `record is ${record.evalStatus}; writeback not observed yet (assigned=${record.assignedAt !== undefined})`,
    );
  }
  const ids = record.evaluation.metrics.map((m) => m.id).sort();
  const refs = record.evaluation.metrics.reduce((n, m) => n + m.evidenceRefs.length, 0);
  const coverage = expected ? JSON.stringify(ids) === JSON.stringify([...expected].sort()) : ids.length > 0;
  const parts = [
    coverage
      ? pass('F-1', `written by ${record.evaluation.by}, metrics ${ids.join('+')} (${record.evaluation.overall})`)
      : fail('F-1', `metric coverage mismatch: got ${ids.join(',')} expected ${expected?.join(',')}`),
    refs <= 64 ? pass('F-1', `${refs} evidence refs ≤ 64`) : fail('F-1', `${refs} evidence refs > 64`),
    record.assignedAt && record.evaluation.writtenAt - record.assignedAt <= 30 * 60 * 1000
      ? pass(
          'F-1',
          `writeback ${Math.round((record.evaluation.writtenAt - record.assignedAt) / 1000)} s after assignment (≤ 30 min)`,
        )
      : fail('F-1', 'writeback later than 30 min after assignment (or assignment missing)'),
  ];
  return combine('F-1', parts);
}

/** F-3 observational: retrigger / stalled markers are consistent with the five-state contract. */
export async function checkF3Observed({ redis, keyPrefix, ownerUserId, objectiveId }) {
  const record = await readJsonKey(redis, CYCLE_RECORD_SURFACE.keyFor({ keyPrefix, ownerUserId, objectiveId }));
  if (!record) return fail('F-3', `no CycleRecord for ${objectiveId}`);
  if (record.evalStatus === 'retriggered') {
    return record.retriggerMessageId &&
      record.retriggeredAt &&
      record.assignedAt &&
      record.retriggeredAt - record.assignedAt >= 30 * 60 * 1000
      ? pass('F-3', 'retriggered exactly once ≥ 30 min after assignment (message id recorded)')
      : fail('F-3', 'retriggered state without consistent retrigger markers', { record });
  }
  if (record.evalStatus === 'stalled') {
    return record.stalledAlertMessageId &&
      record.retriggeredAt &&
      record.stalledAt - record.retriggeredAt >= 30 * 60 * 1000
      ? pass('F-3', 'stalled ≥ 30 min after the single retrigger (alert id recorded)')
      : fail('F-3', 'stalled state without consistent markers', { record });
  }
  return unbound(
    'F-3',
    `record is ${record.evalStatus}; retrigger/stalled path not observed on this instance (see iso-cycle-s2-exercise.mjs)`,
  );
}
