import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { combine, fail, pass, unbound } from '../lib/report.mjs';

// complete-design-v1 §13 / §14 S5: these files and the manifest protocol are deleted.
export const L0_FILES = Object.freeze([
  'scripts/compile-system-prompt-l0.mjs',
  'packages/api/src/domains/cats/services/agents/providers/l0-compiler.ts',
  'packages/api/src/domains/prompt-hooks/native-l0-trace.ts',
]);
const SCAN_DIRS = ['packages/api/src/domains/prompt-hooks', 'packages/api/src/domains/cats/services/agents'];
const MARKERS = ['system-prompt-l0', 'native-l0-trace', 'L0 manifest', 'l0-compiler'];
// S5 @ 16b016a0f: session-init hooks live in assets/prompt-hooks/*/hook.yaml (L1–L7 included as ordinary hooks).
const HOOKS_DIR = ['assets', 'prompt-hooks'];
const L0_ERROR = /\bL0\b|l0-compiler|native-l0-trace|L0 compile|session prompt missing|native session prompt/i;

function* walkSources(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkSources(full);
    else if (/\.(ts|mts|mjs)$/.test(entry) && !/\.test\./.test(entry)) yield full;
  }
}

export function scanL0Residue(projectRoot) {
  const presentFiles = L0_FILES.filter((rel) => existsSync(join(projectRoot, rel)));
  const references = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkSources(join(projectRoot, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const marker of MARKERS) {
        if (text.includes(marker)) references.push({ file: file.slice(projectRoot.length + 1), marker });
      }
    }
  }
  return { presentFiles, references };
}

export function registrySessionInitIds(projectRoot) {
  const root = join(projectRoot, ...HOOKS_DIR);
  const ids = new Set();
  if (!existsSync(root)) return ids;
  for (const dir of readdirSync(root)) {
    const manifest = join(root, dir, 'hook.yaml');
    if (!existsSync(manifest)) continue;
    const text = readFileSync(manifest, 'utf8');
    if (!/^stage:\s*session-init\s*$/m.test(text)) continue;
    const id = text.match(/^id:\s*(\S+)\s*$/m)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

async function latestSummary(redis, keyPrefix, threadId) {
  const turnIds = await redis.zrevrange(`${keyPrefix}injection-trace-index:${threadId}`, 0, 0);
  if (turnIds.length === 0) return null;
  const raw = await redis.get(`${keyPrefix}injection-trace-summary:${threadId}:${turnIds[0]}`);
  return raw ? { turnId: turnIds[0], summary: JSON.parse(raw) } : null;
}

const sessionIds = (summary) =>
  new Set((summary.segments ?? []).filter((s) => s.stage === 'session-init').map((s) => s.segmentId));
const sessionChannel = (summary) =>
  (summary.delivery ?? []).find((d) => d.stage === 'session-init')?.channel ?? null;

function apiLogPart(f8ApiLog) {
  if (!f8ApiLog) return unbound('F-8', 'startup/invocation log not supplied (--f8-api-log)');
  if (!existsSync(f8ApiLog)) return fail('F-8', `api log missing: ${f8ApiLog}`);
  const hits = readFileSync(f8ApiLog, 'utf8')
    .split('\n')
    .filter((line) => /"level":(50|60)/.test(line) && L0_ERROR.test(line));
  return hits.length === 0
    ? pass('F-8', 'api log: zero L0 / session-prompt errors')
    : fail('F-8', `${hits.length} L0 / session-prompt error lines in api log`, { sample: hits.slice(0, 3).map((l) => l.slice(0, 300)) });
}

export async function checkF8({ projectRoot, redis, keyPrefix, f8NativeThread, f8PipelineThread, f8ApiLog }) {
  const residue = scanL0Residue(projectRoot);
  const registry = registrySessionInitIds(projectRoot);
  const lSeries = [...registry].filter((id) => /^L\d+$/.test(id)).sort();
  const parts = [
    residue.presentFiles.length === 0
      ? pass('F-8', 'L0 compiler files removed')
      : fail('F-8', `L0 compiler files still present: ${residue.presentFiles.join(', ')}`),
    residue.references.length === 0
      ? pass('F-8', 'no L0/manifest protocol references')
      : fail('F-8', `${residue.references.length} L0/manifest references remain`, { references: residue.references.slice(0, 20) }),
    registry.size > 0
      ? pass('F-8', `${registry.size} session-init hooks in assets/prompt-hooks (L-series as ordinary hooks: ${lSeries.join(',') || 'none'})`)
      : unbound('F-8', 'assets/prompt-hooks session-init registry not found under --project-root'),
    apiLogPart(f8ApiLog),
  ];
  if (!f8NativeThread || !f8PipelineThread) {
    parts.push(unbound('F-8', 'segment-ID parity native vs pipeline: supply --f8-native-thread and --f8-pipeline-thread'));
    return combine('F-8', parts);
  }
  const native = await latestSummary(redis, keyPrefix, f8NativeThread);
  const pipeline = await latestSummary(redis, keyPrefix, f8PipelineThread);
  if (!native || !pipeline)
    return combine('F-8', [...parts, fail('F-8', 'trace summary missing for native or pipeline thread', { native: !!native, pipeline: !!pipeline })]);
  const nIds = sessionIds(native.summary);
  const pIds = sessionIds(pipeline.summary);
  const onlyNative = [...nIds].filter((id) => !pIds.has(id)).sort();
  const onlyPipeline = [...pIds].filter((id) => !nIds.has(id)).sort();
  parts.push(
    nIds.size > 0 && onlyNative.length === 0 && onlyPipeline.length === 0
      ? pass('F-8', `session-init segment IDs identical native vs pipeline (${nIds.size}: ${[...nIds].sort().join(',')})`)
      : fail('F-8', 'session-init segment IDs differ native vs pipeline', { onlyNative, onlyPipeline, native: nIds.size, pipeline: pIds.size }),
  );
  const outsideRegistry = [...nIds, ...pIds].filter((id) => !registry.has(id)).sort();
  const notTraced = [...registry].filter((id) => !nIds.has(id)).sort();
  parts.push(
    outsideRegistry.length === 0
      ? pass('F-8', `every traced session-init ID is a registry hook (no standalone L-series IDs)${notTraced.length ? `; registry hooks not traced for this cat: ${notTraced.join(',')}` : ''}`)
      : fail('F-8', 'traced session-init IDs outside the hook registry', { outsideRegistry }),
  );
  const nCh = sessionChannel(native.summary);
  const pCh = sessionChannel(pipeline.summary);
  parts.push(
    nCh === 'native-l0' && pCh === 'message-prepend'
      ? pass('F-8', `delivery channels native=${nCh} / pipeline=${pCh} (same pipeline, different carrier)`)
      : fail('F-8', `unexpected session delivery channels native=${nCh} pipeline=${pCh}`),
  );
  parts.push(pass('F-8', `traces: native ${native.summary.catId}@${native.turnId} · pipeline ${pipeline.summary.catId}@${pipeline.turnId}`));
  return combine('F-8', parts);
}
