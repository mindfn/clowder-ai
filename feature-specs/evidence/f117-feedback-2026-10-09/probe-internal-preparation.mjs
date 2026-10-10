// Diagnostic reproduction only: synthetic file data, no runtime Redis, no
// model/client, no production data, no changes to the process being diagnosed.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignalArticleLookup } from '../../../packages/api/dist/domains/signals/services/signal-thread-lookup.js';

const ownedRoot = await mkdtemp(join(tmpdir(), 'f117-preparation-probe-'));
const results = [];
for (const recordCount of [0, 500, 2_000]) {
  const root = join(ownedRoot, String(recordCount));
  const inboxDir = join(root, 'inbox');
  const libraryDir = join(root, 'library');
  await mkdir(inboxDir, { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const records = [];
  for (let index = 0; index < recordCount; index++) {
    const id = `synthetic-${index}`;
    const articleDir = join(libraryDir, id);
    await mkdir(articleDir);
    await writeFile(
      join(articleDir, 'meta.json'),
      JSON.stringify({
        articleId: id,
        threads: [],
        artifacts: [],
        collections: [],
      }),
    );
    records.push({
      id,
      title: id,
      url: 'https://example.invalid',
      source: 'synthetic',
      tier: 1,
      fetchedAt: '2026-10-09T00:00:00Z',
      filePath: `${articleDir}.md`,
    });
  }
  await writeFile(join(inboxDir, '2026-10-09.json'), JSON.stringify(records));
  process.env.SIGNALS_ROOT_DIR = root; // This diagnostic child only.
  const lookup = createSignalArticleLookup();
  const samples = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    const found = await lookup('unlinked-synthetic-thread');
    samples.push({ durationMs: performance.now() - started, matches: found.length });
  }
  results.push({ recordCount, samples });
}
console.log(
  JSON.stringify(
    { kind: 'synthetic-unlinked-signal-lookup', ownedRoot, runtimeDataUsed: false, providerUsed: false, results },
    null,
    2,
  ),
);
