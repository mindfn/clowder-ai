/**
 * F102 Phase B: rebuild-index CLI
 * Scans docs/, parses frontmatter, rebuilds evidence.sqlite FTS index.
 *
 * Usage: pnpm --filter @cat-cafe/api rebuild-index [--force]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEvidenceDbPath } from '../config/data-dirs.js';
import { IndexBuilder } from '../domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../domains/memory/SqliteEvidenceStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('rebuild-index');

interface RebuildIndexArgs {
  force: boolean;
  docsRoot: string;
  dbPath: string;
}

/**
 * Resolve repoRoot the same way index.ts main() does — locate the directory
 * that contains `docs/features` either at cwd or two levels up (monorepo).
 */
function detectRepoRoot(cwd: string): string {
  if (existsSync(resolve(cwd, 'docs', 'features'))) return cwd;
  if (existsSync(resolve(cwd, '..', '..', 'docs', 'features'))) return resolve(cwd, '..', '..');
  return cwd;
}

function parseArgs(argv: string[]): RebuildIndexArgs {
  const force = argv.includes('--force');
  const repoRoot = detectRepoRoot(process.cwd());
  // #671: honor DATA_DIR + share the same path the API server uses, instead of
  // hardcoding `{cwd}/data/evidence.sqlite` (which never matched production
  // before either — the legacy path is `{repoRoot}/evidence.sqlite`).
  const dbPath = resolveEvidenceDbPath(repoRoot);
  const docsRoot = process.env.DOCS_ROOT ? resolve(process.env.DOCS_ROOT) : resolve(repoRoot, 'docs');
  return { force, docsRoot, dbPath };
}

export async function runRebuildIndexCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  log.info({ docs: args.docsRoot, db: args.dbPath, force: args.force }, 'Rebuild index starting');

  const store = new SqliteEvidenceStore(args.dbPath);
  await store.initialize();

  const builder = new IndexBuilder(store, args.docsRoot);

  const result = await builder.rebuild({ force: args.force });

  log.info(
    { docsIndexed: result.docsIndexed, docsSkipped: result.docsSkipped, durationMs: result.durationMs },
    'Index rebuilt',
  );

  const consistency = await builder.checkConsistency();
  if (!consistency.ok) {
    log.error({ docCount: consistency.docCount, ftsCount: consistency.ftsCount }, 'CONSISTENCY ERROR');
    process.exitCode = 1;
  } else {
    log.info({ docCount: consistency.docCount }, 'Consistency check passed');
  }

  store.close();
}

// Direct invocation
const entryPath = process.argv[1];
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runRebuildIndexCli().catch((err) => {
    log.error({ error: err }, 'Fatal error');
    process.exitCode = 1;
  });
}
