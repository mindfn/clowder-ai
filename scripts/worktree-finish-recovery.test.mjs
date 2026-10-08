import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { it } from 'node:test';
import { directReleaseReceipt, removeFinishedWorktree } from './lib/worktree-direct-release.mjs';
import { fixture, git, NOW, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { moveToQuarantine, quarantineRoot, readQuarantineRecords } from './lib/worktree-quarantine.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';

it('returns pending transaction recovery when completion recording fails after the move', () => {
  const fx = fixture();
  try {
    const path = fx.make();
    const root = quarantineRoot(fx.root);
    let ticks = 0;
    let failure;
    try {
      moveToQuarantine({
        repo: fx.repo,
        root,
        entry: {
          name: basename(path),
          path,
          registered: true,
          kind: 'worktree',
          lifecycle: { owner: 'codex61-sol' },
          finishSourceRef: SOURCE,
        },
        clock: () => {
          if (++ticks === 2) {
            renameSync(join(root, 'ledger.jsonl'), join(root, 'saved-pending.jsonl'));
            mkdirSync(join(root, 'ledger.jsonl')); // append failure, after a successful actual move
          }
          return NOW;
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(existsSync(path), false);
    assert.ok(failure?.recovery, 'moved worktree must expose its pending transaction and restore command');
    assert.equal(failure.recovery.state, 'pending');
    assert.equal(existsSync(failure.recovery.quarantinePath), true);
    assert.equal(JSON.parse(readFileSync(join(root, 'saved-pending.jsonl'), 'utf8')).txn, failure.recovery.txn);
    assert.equal(readQuarantineRecords(root).size, 0);
    execFileSync('/bin/sh', ['-c', failure.recovery.restore]);
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

it('returns recoverable originals but no success receipt when completion recording fails after actual removal', () => {
  const fx = fixture();
  try {
    const path = fx.make();
    const root = quarantineRoot(fx.root);
    let ticks = 0;
    let failure;
    try {
      removeFinishedWorktree({
        repo: fx.repo,
        actor: 'codex61-sol',
        authorizationRef: SOURCE,
        root,
        entry: {
          path,
          name: basename(path),
          head: git(path, 'rev-parse', 'HEAD').trim(),
          lifecycle: lifecycleConfig(path, '--worktree'),
          finishSourceRef: SOURCE,
        },
        validate: () => {},
        clock: () => {
          if (++ticks === 2) {
            renameSync(join(root, 'ledger.jsonl'), join(root, 'saved-pending.jsonl'));
            mkdirSync(join(root, 'ledger.jsonl'));
          }
          return NOW;
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(existsSync(path), false);
    assert.equal(failure?.recovery?.state, 'pending');
    assert.equal(existsSync(failure.recovery.archivePath), true);
    assert.equal(directReleaseReceipt({ repo: fx.repo, root, path, owner: 'codex61-sol', sourceRef: SOURCE }), null);
    execFileSync('/bin/sh', ['-c', failure.recovery.restore]);
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'original\n');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
