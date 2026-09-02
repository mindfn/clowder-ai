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

export function checkF8({ projectRoot }) {
  const residue = scanL0Residue(projectRoot);
  const parts = [
    residue.presentFiles.length === 0
      ? pass('F-8', 'L0 compiler files removed')
      : fail('F-8', `L0 compiler files still present: ${residue.presentFiles.join(', ')}`),
    residue.references.length === 0
      ? pass('F-8', 'no L0/manifest protocol references')
      : fail('F-8', `${residue.references.length} L0/manifest references remain`, {
          references: residue.references.slice(0, 20),
        }),
    unbound('F-8', 'segment-ID parity native vs pipeline + no L1–L7 in tracing: surface not bound (S5)'),
  ];
  return combine('F-8', parts);
}
