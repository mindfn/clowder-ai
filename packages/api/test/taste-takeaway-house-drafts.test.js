import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { importTasteTakeawayCandidates } from '../dist/domains/memory/taste/TasteTakeawayCandidateImporter.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDraftPath = 'docs/features/evidence/F321/takeaway-drafts.public.json';

function revisionOf(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function privateVignette(quote) {
  return `---\nwhen: 2026-10-06\nquotes: ["${quote}"]\nscene: "Private candidate"\ntags: ["private"]\ndimension: relationship-stance\nprivacy: sensitive\n---\n`;
}

describe('F321 Taste takeaway candidate importer', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('canonicalizes all 75 public and 2 private drafts as TTL-free revision-bound pending confirmations', async () => {
    const publicDrafts = JSON.parse(readFileSync(join(repositoryRoot, publicDraftPath), 'utf8'));
    assert.equal(publicDrafts.schemaVersion, 1);
    assert.equal(publicDrafts.status, 'cat_draft_unconfirmed');
    assert.equal(publicDrafts.drafts.length, 75);
    assert.equal(new Set(publicDrafts.drafts.map((draft) => draft.sourcePath)).size, 75);

    const root = mkdtempSync(join(tmpdir(), 'f321-taste-candidates-'));
    roots.push(root);
    mkdirSync(dirname(join(root, publicDraftPath)), { recursive: true });
    cpSync(join(repositoryRoot, publicDraftPath), join(root, publicDraftPath));
    for (const draft of publicDrafts.drafts) {
      const source = join(repositoryRoot, draft.sourcePath);
      const content = readFileSync(source);
      assert.equal(revisionOf(content), draft.sourceRevision, `stale public draft: ${draft.sourcePath}`);
      mkdirSync(dirname(join(root, draft.sourcePath)), { recursive: true });
      cpSync(source, join(root, draft.sourcePath));
    }

    const privateDrafts = ['private/taste/private-one.md', 'private/taste/private-two.md'].map((sourcePath, index) => {
      const content = privateVignette(`private-${index + 1}`);
      mkdirSync(dirname(join(root, sourcePath)), { recursive: true });
      writeFileSync(join(root, sourcePath), content, 'utf8');
      return {
        sourcePath,
        takeaway: `我们以为 You 希望私有候选 ${index + 1} 等待本人确认。`,
        sourceRevision: revisionOf(content),
      };
    });
    const privateDraftFile = join(root, 'private/f321/takeaway-drafts.json');
    mkdirSync(dirname(privateDraftFile), { recursive: true });
    writeFileSync(
      privateDraftFile,
      `${JSON.stringify({ schemaVersion: 1, status: 'cat_draft_unconfirmed', drafts: privateDrafts }, null, 2)}\n`,
      'utf8',
    );

    const db = new Database(':memory:');
    applyMigrations(db);
    const result = await importTasteTakeawayCandidates({
      repository: { canonicalRoot: () => root, approvalLockKey: () => 'candidate-test' },
      lifecycleStore: new TasteMemoryLifecycleStore(db),
      ownerUserId: 'candidate-owner',
    });
    assert.deepEqual(result, { imported: 77, stale: 0, unavailableInputs: [] });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM taste_takeaway_candidates WHERE status = 'pending'").get().count,
      77,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM taste_takeaway_candidates').get().count, 77);
    db.close();
  });
});
