import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonKey } from '../lib/redis.mjs';
import { combine, fail, pass, unbound } from '../lib/report.mjs';
import { CYCLE_RECORD_SURFACE } from './f2-f3.mjs';

const STATES = new Set(['idle', 'requested', 'retriggered', 'written', 'stalled']);
const ROUTES = new Set(['cumulative', 'counterexamples', 'cadence']);
const CHECKER = 'packages/api/src/infrastructure/harness-eval/evaluation/CycleTriggerChecker.ts';
const REGISTRY = 'docs/harness-feedback/objectives/registry.yaml';

export async function readCycle(redis, options) {
  const key = CYCLE_RECORD_SURFACE.keyFor(options);
  return { key, record: await readJsonKey(redis, key) };
}

/** F-7 observational part: registry-driven thresholds, no literals in checker, record shape after a trigger. */
export async function checkF7({ redis, keyPrefix, ownerUserId, objectiveId, projectRoot }) {
  const parts = [];
  const checkerPath = join(projectRoot, CHECKER);
  const registryPath = join(projectRoot, REGISTRY);
  if (!existsSync(checkerPath) || !existsSync(registryPath)) {
    return fail('F-7', 'S1 checker or objective registry missing in project root', { checkerPath, registryPath });
  }
  const literalHits = readFileSync(checkerPath, 'utf8').match(/\b(200|7200000|604800000|3600000)\b/g) ?? [];
  parts.push(
    literalHits.length === 0
      ? pass('F-7', 'checker has no threshold literals')
      : fail('F-7', `checker hard-codes thresholds: ${literalHits.join(',')}`),
  );
  const registry = readFileSync(registryPath, 'utf8');
  const modelsWithoutTrigger =
    (registry.match(/^\s+- id: em-[a-z0-9-]+/gm) ?? []).length - (registry.match(/cycleTrigger:/g) ?? []).length;
  parts.push(
    modelsWithoutTrigger === 0
      ? pass('F-7', 'every evaluation model declares cycleTrigger')
      : fail('F-7', `${modelsWithoutTrigger} evaluation models lack cycleTrigger`),
  );
  const { key, record } = await readCycle(redis, { keyPrefix, ownerUserId, objectiveId });
  if (!record) return combine('F-7', [...parts, fail('F-7', `no CycleRecord for ${objectiveId}`, { key })]);
  if (!STATES.has(record.evalStatus)) parts.push(fail('F-7', `unknown evalStatus ${record.evalStatus}`));
  if (record.evalStatus === 'requested') {
    const routes = record.triggeredBy ?? [];
    const last = record.windows?.at(-1);
    const shapeOk =
      routes.length > 0 &&
      routes.every((route) => ROUTES.has(route)) &&
      typeof record.cycleEnd === 'number' &&
      record.cycleEnd > record.cycleStart &&
      last?.start === record.cycleStart &&
      last?.end === record.cycleEnd;
    parts.push(
      shapeOk
        ? pass('F-7', `requested via ${routes.join('+')}, window ${record.cycleStart}→${record.cycleEnd}`)
        : fail('F-7', 'requested record has inconsistent routes/window', { record }),
    );
  } else {
    parts.push(unbound('F-7', `record is ${record.evalStatus}; trigger not yet exercised on this instance`));
  }
  parts.push(unbound('F-7', 'anyOf/interval/no-reopen dynamics: run iso-cycle-exercise.mjs on the isolated stack'));
  return combine('F-7', parts);
}

/** F-4 observational part: after a skip, the next record's windows[] includes the skipped cycle window. */
export async function checkF4({ redis, keyPrefix, ownerUserId, objectiveId }) {
  const ids = await redis.zrevrange(
    CYCLE_RECORD_SURFACE.historyIndexFor({ keyPrefix, ownerUserId, objectiveId }),
    0,
    -1,
  );
  if (ids.length === 0) return unbound('F-4', 'no cycle history yet (skip lookback needs a closed skip cycle)');
  const history = [];
  for (const cycleId of ids) {
    const record = await readJsonKey(
      redis,
      CYCLE_RECORD_SURFACE.historyFor({ keyPrefix, ownerUserId, objectiveId, cycleId }),
    );
    if (!record) return fail('F-4', `history index points to a missing record ${cycleId}`);
    history.push(record);
  }
  const { record: current } = await readCycle(redis, { keyPrefix, ownerUserId, objectiveId });
  const latest = history[0];
  const skipped = latest.approval?.state === 'skipped' || latest.evaluation?.overall === 'insufficient_evidence';
  const parts = [];
  if (current && typeof latest.cycleEnd === 'number') {
    parts.push(
      current.cycleStart === latest.cycleEnd
        ? pass('F-4', 'next cycleStart == previous cycleEnd (start always refreshes)')
        : fail('F-4', `cycleStart ${current.cycleStart} != previous cycleEnd ${latest.cycleEnd}`),
    );
  }
  if (!skipped)
    return combine('F-4', [...parts, unbound('F-4', 'latest closed cycle was not a skip; lookback not exercised')]);
  if (!current || current.evalStatus !== 'requested') {
    return combine('F-4', [
      ...parts,
      unbound('F-4', 'next cycle not requested yet; windows[] lookback not observable'),
    ]);
  }
  const includesSkip = current.windows.some((w) => w.start === latest.cycleStart && w.end === latest.cycleEnd);
  parts.push(
    current.windows.length >= 2 && includesSkip
      ? pass('F-4', `windows[] (${current.windows.length}) includes the skipped cycle window`)
      : fail('F-4', 'windows[] does not include the skipped cycle window', { windows: current.windows }),
  );
  return combine('F-4', parts);
}
