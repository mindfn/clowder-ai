import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicTestArtifactFingerprint, validatePublicTestProvenance } from './public-test-provenance.mjs';
import { comparePublicTestStrings, publicTestInvariant as invariant } from './public-test-support.mjs';
import { publicTestSelectionHash } from './resolve-public-test-files.mjs';

export const MIN_PUBLIC_TEST_SHARDS = 4;
const MAX_SHARDS = 6;
export const SERIAL_PUBLIC_TEST_SHARDS = 5;
export const SHARED_SERIAL_LANE = 'serial-shared';
const SHARED_RESOURCE_MARKERS = new Set(['network', 'external-command']);

function digest(value) {
  return publicTestArtifactFingerprint(value);
}

export function normalizeSelectedFiles(selectedFiles) {
  invariant(Array.isArray(selectedFiles) && selectedFiles.length > 0, 'selectedFiles must be a non-empty array');
  const normalized = selectedFiles.map((file) => {
    invariant(
      typeof file === 'string' && file.startsWith('test/') && file.endsWith('.test.js'),
      'invalid selected test file',
    );
    return file;
  });
  invariant(new Set(normalized).size === normalized.length, 'selectedFiles contains duplicate files');
  return [...normalized].sort();
}

function compileClassification(classification) {
  invariant(classification && classification.version === 1, 'classification version must be 1');
  invariant(Array.isArray(classification.rules), 'classification.rules must be an array');
  return classification.rules.map((rule) => {
    invariant(rule && typeof rule.id === 'string' && rule.id.length > 0, 'classification rule id is required');
    invariant(
      typeof rule.match === 'string' && rule.match.length > 0,
      `classification rule ${rule.id} match is required`,
    );
    invariant(rule.lane === 'serial' || rule.lane === 'pure', `classification rule ${rule.id} lane is invalid`);
    let regex;
    try {
      regex = new RegExp(rule.match);
    } catch (error) {
      throw new Error(`classification rule ${rule.id} has invalid regex: ${error.message}`);
    }
    if (rule.lane === 'serial') {
      invariant(
        typeof rule.reason === 'string' && rule.reason.length > 0,
        `classification rule ${rule.id} reason is required`,
      );
    } else {
      invariant(
        rule.isolationEvidence && typeof rule.isolationEvidence === 'object',
        `classification rule ${rule.id} requires isolationEvidence`,
      );
      invariant(
        typeof rule.isolationEvidence.kind === 'string' &&
          typeof rule.isolationEvidence.rulesVersion === 'string' &&
          typeof rule.isolationEvidence.source === 'string',
        `classification rule ${rule.id} isolationEvidence is incomplete`,
      );
    }
    return { ...rule, regex };
  });
}

function classifyFile(file, rules, isolationAuditByFile) {
  const matches = rules.filter((rule) => rule.regex.test(file));
  invariant(matches.length <= 1, `classification has overlapping rules for ${file}`);
  if (matches.length === 0) {
    return {
      lane: 'serial-shared',
      ruleId: 'default-serial-shared',
      reason: 'unclassified resource scope defaults to the shared serial lane',
    };
  }
  const [rule] = matches;
  const audit = isolationAuditByFile?.[file];
  const hasSharedResourceMarker = audit?.markers?.some((marker) => SHARED_RESOURCE_MARKERS.has(marker)) ?? false;
  if (rule.lane === 'serial') {
    if (!audit || hasSharedResourceMarker) {
      return {
        lane: 'serial-shared',
        ruleId: rule.id,
        reason: !audit ? 'missing current resource-scope audit' : audit.reason,
        scopeEvidence: audit?.evidence,
      };
    }
    return {
      lane: 'serial-local',
      ruleId: rule.id,
      reason: rule.reason,
      scopeEvidence: audit.evidence,
    };
  }
  if (!audit?.ok) {
    return {
      lane: !audit || hasSharedResourceMarker ? 'serial-shared' : 'serial-local',
      ruleId: `audit-${rule.id}`,
      reason: audit?.reason ?? 'missing current isolation proof',
      scopeEvidence: audit?.evidence,
    };
  }
  return {
    lane: 'pure',
    ruleId: rule.id,
    isolationEvidence: audit?.evidence ?? rule.isolationEvidence,
  };
}

function durationFor(file, timingByFile) {
  const candidate = timingByFile?.[file];
  if (candidate === undefined) return 1_000;
  invariant(Number.isFinite(candidate) && candidate >= 0, `timing for ${file} must be a non-negative number`);
  return candidate;
}

function sortedShards(shards, prefix) {
  return [...shards]
    .sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs ||
        comparePublicTestStrings(left.files.join('\n'), right.files.join('\n')),
    )
    .map((shard, index) => ({
      id: `${prefix}-${index + 1}`,
      files: [...shard.files].sort(),
      estimatedDurationMs: shard.estimatedDurationMs,
    }));
}

function balancedShards(entries, shardCount, prefix) {
  const worklist = [...entries].sort(
    (left, right) => right.durationMs - left.durationMs || comparePublicTestStrings(left.file, right.file),
  );
  const shards = Array.from({ length: shardCount }, () => ({ files: [], estimatedDurationMs: 0 }));
  for (const entry of worklist) {
    const receiver = [...shards].sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs ||
        comparePublicTestStrings(left.files.join('\n'), right.files.join('\n')),
    )[0];
    receiver.files.push(entry.file);
    receiver.estimatedDurationMs += entry.durationMs;
  }
  return sortedShards(shards, prefix);
}

function normalizeTimingSource(source) {
  if (source === undefined) return { kind: 'unmeasured_default', estimatedDurationMs: 1_000 };
  invariant(source && typeof source === 'object' && !Array.isArray(source), 'timingSource must be an object');
  if (source.kind === 'unmeasured_default') {
    invariant(source.estimatedDurationMs === 1_000, 'unmeasured timing source must use the deterministic default');
    return { kind: 'unmeasured_default', estimatedDurationMs: 1_000 };
  }
  invariant(source.kind === 'public_test_shard_summary', 'timingSource kind is unsupported');
  invariant(
    typeof source.artifactFingerprint === 'string' && /^[0-9a-f]{64}$/.test(source.artifactFingerprint),
    'timingSource artifactFingerprint must be SHA-256',
  );
  return {
    kind: source.kind,
    artifactFingerprint: source.artifactFingerprint,
    provenance: validatePublicTestProvenance(source.provenance),
  };
}

function normalizePlannerProvenance(provenance) {
  return validatePublicTestProvenance(provenance);
}

export function validatePublicTestShardPlan(plan, selectedFiles) {
  invariant(plan && plan.schemaVersion === 2, 'shard plan schemaVersion must be 2');
  const expected = normalizeSelectedFiles(selectedFiles);
  invariant(
    plan.selectionHash === publicTestSelectionHash(expected),
    'shard plan selectionHash does not match selected files',
  );
  invariant(
    typeof plan.exclusionRegistryHash === 'string' && plan.exclusionRegistryHash.length > 0,
    'shard plan requires exclusion registry hash',
  );
  normalizePlannerProvenance(plan.plannerProvenance);
  normalizeTimingSource(plan.timingSource);
  invariant(
    Array.isArray(plan.serialShards) && plan.serialShards.length === SERIAL_PUBLIC_TEST_SHARDS,
    `shard plan requires ${SERIAL_PUBLIC_TEST_SHARDS} serial shards`,
  );
  invariant(
    plan.sharedSerialLane?.id === SHARED_SERIAL_LANE && Array.isArray(plan.sharedSerialLane.files),
    'shard plan requires the shared serial lane',
  );
  invariant(
    Array.isArray(plan.pureShards) &&
      plan.pureShards.length >= MIN_PUBLIC_TEST_SHARDS &&
      plan.pureShards.length <= MAX_SHARDS,
    'shard plan requires 4–6 pure shards',
  );
  const allShards = [plan.sharedSerialLane, ...plan.serialShards, ...plan.pureShards];
  const validLaneIds = new Set(allShards.map((shard) => shard.id));
  invariant(validLaneIds.size === allShards.length, 'shard plan lane ids must be unique');
  const assigned = [
    ...plan.sharedSerialLane.files,
    ...plan.serialShards.flatMap((shard, index) => {
      invariant(shard.id === `serial-local-${index + 1}`, 'serial shard ids must be stable and contiguous');
      invariant(Array.isArray(shard.files), 'serial shard files must be an array');
      return shard.files;
    }),
    ...plan.pureShards.flatMap((shard, index) => {
      invariant(shard.id === `pure-${index + 1}`, 'pure shard ids must be stable and contiguous');
      invariant(Array.isArray(shard.files), 'pure shard files must be an array');
      return shard.files;
    }),
  ].sort();
  invariant(
    assigned.length === expected.length && assigned.every((file, index) => file === expected[index]),
    'every selected public test must be assigned exactly once',
  );
  invariant(
    plan.assignments && typeof plan.assignments === 'object' && !Array.isArray(plan.assignments),
    'shard plan requires assignments',
  );
  const laneByFile = new Map();
  for (const shard of allShards) {
    for (const file of shard.files) laneByFile.set(file, shard.id);
  }
  for (const file of expected) {
    const assignment = plan.assignments[file];
    invariant(assignment && typeof assignment === 'object', `shard plan missing assignment for ${file}`);
    invariant(validLaneIds.has(assignment.lane), `shard plan has invalid lane for ${file}`);
    invariant(
      assignment.lane === laneByFile.get(file),
      `shard plan assignment lane does not match file placement for ${file}`,
    );
    invariant(
      typeof assignment.ruleId === 'string' && assignment.ruleId.length > 0,
      `shard plan missing classification for ${file}`,
    );
    if (/^serial-local-/.test(assignment.lane)) {
      invariant(
        ['static-resource-scope', 'static-negative-scan'].includes(assignment.scopeEvidence?.kind) &&
          Array.isArray(assignment.scopeEvidence.markers) &&
          assignment.scopeEvidence.markers.every((marker) => !SHARED_RESOURCE_MARKERS.has(marker)),
        `local serial assignment lacks machine-local scope evidence for ${file}`,
      );
    }
  }
  invariant(Object.keys(plan.assignments).length === expected.length, 'shard plan assignments contain unknown files');
  const withoutFingerprint = { ...plan };
  delete withoutFingerprint.planFingerprint;
  invariant(
    typeof plan.planFingerprint === 'string' && plan.planFingerprint === digest(withoutFingerprint),
    'shard plan fingerprint mismatch',
  );
  return plan;
}

export function planPublicTestShards({
  selectedFiles,
  selectionHash,
  exclusionRegistryHash,
  classification,
  plannerProvenance,
  timingByFile = {},
  timingSource,
  isolationAuditByFile,
  shardCount = MIN_PUBLIC_TEST_SHARDS,
}) {
  invariant(
    Number.isInteger(shardCount) && shardCount >= MIN_PUBLIC_TEST_SHARDS && shardCount <= MAX_SHARDS,
    'shardCount must be 4–6',
  );
  invariant(typeof selectionHash === 'string' && selectionHash.length > 0, 'selectionHash is required');
  const selected = normalizeSelectedFiles(selectedFiles);
  invariant(selectionHash === publicTestSelectionHash(selected), 'selectionHash does not match selectedFiles');
  invariant(
    typeof exclusionRegistryHash === 'string' && exclusionRegistryHash.length > 0,
    'exclusionRegistryHash is required',
  );
  const rules = compileClassification(classification);
  const sharedSerial = [];
  const localSerial = [];
  const pure = [];
  for (const file of selected) {
    const classificationResult = classifyFile(file, rules, isolationAuditByFile);
    const durationMs = durationFor(file, timingByFile);
    const entry = { file, durationMs, ...classificationResult };
    if (classificationResult.lane === 'serial-shared') sharedSerial.push(entry);
    else if (classificationResult.lane === 'serial-local') localSerial.push(entry);
    else pure.push(entry);
  }
  const plan = {
    schemaVersion: 2,
    selectionHash,
    selectedFiles: selected,
    exclusionRegistryHash,
    classificationVersion: classification.version,
    plannerProvenance: normalizePlannerProvenance(plannerProvenance),
    timingSource: normalizeTimingSource(timingSource),
    sharedSerialLane: {
      id: SHARED_SERIAL_LANE,
      files: sharedSerial.map((entry) => entry.file).sort(),
      estimatedDurationMs: sharedSerial.reduce((total, entry) => total + entry.durationMs, 0),
    },
    serialShards: balancedShards(localSerial, SERIAL_PUBLIC_TEST_SHARDS, 'serial-local'),
    pureShards: balancedShards(pure, shardCount, 'pure'),
  };
  const assignments = {};
  const entryByFile = new Map([...sharedSerial, ...localSerial, ...pure].map((entry) => [entry.file, entry]));
  for (const shard of [plan.sharedSerialLane, ...plan.serialShards]) {
    for (const file of shard.files) {
      const entry = entryByFile.get(file);
      assignments[file] = {
        lane: shard.id,
        ruleId: entry.ruleId,
        reason: entry.reason,
        scopeEvidence: entry.scopeEvidence,
        estimatedDurationMs: entry.durationMs,
      };
    }
  }
  for (const shard of plan.pureShards) {
    for (const file of shard.files) {
      const entry = entryByFile.get(file);
      assignments[file] = {
        lane: shard.id,
        ruleId: entry.ruleId,
        isolationEvidence: entry.isolationEvidence,
        estimatedDurationMs: entry.durationMs,
      };
    }
  }
  plan.assignments = Object.fromEntries(
    Object.entries(assignments).sort(([left], [right]) => comparePublicTestStrings(left, right)),
  );
  plan.planFingerprint = digest(plan);
  return validatePublicTestShardPlan(plan, selected);
}

const STATIC_STATEFUL_MARKERS = [
  { id: 'redis', pattern: /\b(?:redis|ioredis|redisClient|redisStore|REDIS_URL)\b/i },
  { id: 'port', pattern: /\b(?:createServer|API_SERVER_PORT|FRONTEND_PORT)\b|\blisten\s*\(|localhost:/i },
  { id: 'filesystem-watch', pattern: /\b(?:fs\.watch|watchFile|watchpack|chokidar)\b/i },
  {
    id: 'filesystem-write',
    pattern: /\b(?:writeFile|appendFile|mkdir|mkdtemp|rename|unlink|rmSync?|chmod|copyFile)\b/i,
  },
  { id: 'process', pattern: /\bchild_process\b|\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/i },
  { id: 'worker', pattern: /\bworker_threads\b|\bnew\s+Worker\s*\(/i },
  { id: 'network', pattern: /\b(?:fetch|WebSocket)\s*\(|\b(?:http|https)\.request\b|\bundici\b/i },
  {
    id: 'external-command',
    pattern: /\b(?:curl|wget|ssh|gh)\b|\bgit\b[^\n]{0,120}\b(?:fetch|pull|push)\b/i,
  },
  { id: 'dynamic-module-load', pattern: /\b(?:import|require)\s*\(/ },
];

export async function auditPublicTestIsolation({ selectedFiles, packageRoot }) {
  const audit = {};
  for (const file of normalizeSelectedFiles(selectedFiles)) {
    const source = await readFile(resolve(packageRoot, file), 'utf8');
    const matched = STATIC_STATEFUL_MARKERS.filter((marker) => marker.pattern.test(source)).map((marker) => marker.id);
    if (matched.length > 0) {
      audit[file] = {
        ok: false,
        markers: matched,
        reason: `static isolation audit found ${matched.join(', ')}`,
        evidence: {
          kind: 'static-resource-scope',
          rulesVersion: 'f308-scope-v1',
          source: `sha256:${digest(source)}`,
          markers: matched,
        },
      };
    } else {
      audit[file] = {
        ok: true,
        markers: [],
        evidence: {
          kind: 'static-negative-scan',
          rulesVersion: 'f308-static-v1',
          source: `sha256:${digest(source)}`,
          markers: [],
        },
      };
    }
  }
  return audit;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  import('./plan-public-test-shards-cli.mjs')
    .then(({ runPublicTestShardPlannerCli }) => runPublicTestShardPlannerCli())
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
