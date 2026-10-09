import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./gh', import.meta.url));
const census = 'docs/harness-feedback/registry/measurement-bundles.yaml';
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function commit(root, subject = 'fixture change') {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fork-verdict-guard-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  const checkerRoot = join(root, 'implementation');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'develop_base', repo);
  git(repo, 'config', 'user.name', 'Guard Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  write(repo, census, 'old census\n');
  commit(repo, 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'develop_base');
  git(repo, 'switch', '-c', 'main');
  write(repo, census, 'published census\n');
  commit(repo, 'publish main');
  git(repo, 'push', 'origin', 'main');
  // Production reads the declared repository identity; Git's fixture-only
  // transport rewrite keeps every remote operation inside this owned bare repo.
  git(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/mindfn/clowder-ai.git');
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/mindfn/clowder-ai.git');
  git(repo, 'switch', '-c', 'integration');
  write(repo, 'app.txt', 'ordinary integration\n');
  commit(repo);
  const delegated = join(root, 'delegated.json');
  const checked = join(root, 'checked.json');
  const delegate = join(root, 'fixture-gh.mjs');
  writeFileSync(
    delegate,
    '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; writeFileSync(process.env.FIXTURE_DELEGATED, JSON.stringify(process.argv.slice(2)));\n',
  );
  chmodSync(delegate, 0o755);
  return { root, repo, remote, checkerRoot, delegate, delegated, checked };
}
function checker(f, exit = 0) {
  write(
    f.checkerRoot,
    'scripts/check-verdict-publish-contract.mjs',
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE_CHECKED, JSON.stringify(process.argv.slice(2))); process.stderr.write('fixture_contract_checked\\n'); process.exit(${exit});\n`,
  );
}
function run(f, extra = [], env = {}) {
  const args = [
    'pr',
    'create',
    '--repo',
    'mindfn/clowder-ai',
    '--base',
    'develop_base',
    '--title',
    'Integrate A2A',
    ...extra,
  ];
  const r = spawnSync(process.execPath, [guard, ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAT_CAFE_REAL_GH_PATH: f.delegate,
      CAT_CAFE_VERDICT_GH_GUARD_ROOT: f.checkerRoot,
      CAT_CAFE_VERDICT_REPO_FULL_NAME: 'mindfn/clowder-ai',
      FIXTURE_DELEGATED: f.delegated,
      FIXTURE_CHECKED: f.checked,
      ...env,
    },
  });
  return { ...r, args };
}
test('ordinary integration reuses published main objects without invoking the missing verdict checker', () => {
  const f = fixture();
  const r = run(f, [], { CAT_CAFE_VERDICT_REPO_FULL_NAME: 'zts212653/cat-cafe' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.delegated)), r.args);
  assert.equal(existsSync(f.checked), false);
});
for (const [name, path] of [
  ['new verdict', 'docs/harness-feedback/verdicts/new.md'],
  ['new bundle', 'docs/harness-feedback/bundles/new/packet.json'],
  ['modified census', census],
  ['NUL path with newline', 'docs/harness-feedback/bundles/new\nline/packet.json'],
]) {
  test(`${name} still invokes the contract and preserves refusal`, () => {
    const f = fixture();
    write(f.repo, path, 'new evidence\n');
    commit(f.repo);
    checker(f, 7);
    const r = run(f, name === 'NUL path with newline' ? ['--base', 'main'] : []);
    assert.equal(r.status, 7, r.stderr);
    assert.ok(existsSync(f.checked));
    assert.equal(existsSync(f.delegated), false);
  });
}
test('a real verdict with missing checker fails closed with a named missing dependency', () => {
  const f = fixture();
  write(f.repo, 'docs/harness-feedback/verdicts/new.md', 'verdict\n');
  commit(f.repo);
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_guard_unavailable:/);
  assert.equal(existsSync(f.delegated), false);
});
test('wrong target stays refused before the checker is called', () => {
  const f = fixture();
  write(f.repo, census, 'new verdict census\n');
  commit(f.repo);
  checker(f);
  const r = run(f, [], { CAT_CAFE_VERDICT_REPO_FULL_NAME: 'zts212653/cat-cafe' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_wrong_repository:/);
  assert.equal(existsSync(f.checked), false);
  assert.equal(existsSync(f.delegated), false);
});
test('published objects from another repository do not waive target checks', () => {
  const f = fixture();
  checker(f, 7);
  const r = run(f, ['--repo', 'another/clowder-ai']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_wrong_repository:/);
  assert.equal(existsSync(f.delegated), false);
});
test('a different GitHub host cannot inherit the github.com sync exemption', () => {
  const f = fixture();
  checker(f, 7);
  const r = run(f, [], { GH_HOST: 'github.example.invalid' });
  assert.equal(r.status, 7);
  assert.ok(existsSync(f.checked));
  assert.equal(existsSync(f.delegated), false);
});
test('explicit verdict title cannot be exempted by published main equality', () => {
  const f = fixture();
  checker(f, 7);
  const r = run(f, ['--title', 'verdict(eval:a2a): new publication']);
  assert.equal(r.status, 7);
  assert.ok(existsSync(f.checked));
});
test('a successful existing contract delegates the exact request once', () => {
  const f = fixture();
  write(f.repo, census, 'new verdict census\n');
  const head = commit(f.repo);
  checker(f);
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(f.checked)).at(-1), head);
  assert.deepEqual(JSON.parse(readFileSync(f.delegated)), r.args);
});
test('unpublished main-shaped objects cannot be used as sync evidence', () => {
  const f = fixture();
  git(f.repo, 'switch', 'main');
  write(f.repo, census, 'unpublished\n');
  const fake = commit(f.repo);
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', fake);
  git(f.repo, 'switch', 'integration');
  git(f.repo, 'merge', '--no-edit', 'main');
  checker(f, 7);
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(f.delegated), false);
});
test('same object without published main ancestry is not a sync', () => {
  const f = fixture();
  git(f.repo, 'switch', '-c', 'manual', 'develop_base');
  write(f.repo, census, 'published census\n');
  commit(f.repo);
  checker(f, 7);
  const r = run(f);
  assert.equal(r.status, 7);
  assert.ok(existsSync(f.checked));
});
test('mode change cannot be exempted by equal blob', () => {
  const f = fixture();
  chmodSync(join(f.repo, census), 0o755);
  commit(f.repo);
  checker(f, 7);
  const r = run(f);
  assert.equal(r.status, 7);
});
test('deletion of a published artifact still invokes the contract', () => {
  const f = fixture();
  git(f.repo, 'rm', '--', census);
  commit(f.repo);
  checker(f, 7);
  assert.equal(run(f).status, 7);
});
test('replacing a regular artifact with a symlink cannot be a sync', () => {
  const f = fixture();
  unlinkSync(join(f.repo, census));
  symlinkSync('elsewhere', join(f.repo, census));
  commit(f.repo);
  checker(f, 7);
  assert.equal(run(f).status, 7);
});
test('remote query failure cannot be treated as already published', () => {
  const f = fixture();
  git(f.repo, 'config', 'url./not-an-existing-owned-repo.insteadOf', 'https://github.com/mindfn/clowder-ai.git');
  git(f.repo, 'config', '--unset', `url.${f.remote}.insteadOf`);
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_candidate_unavailable:/);
  assert.equal(existsSync(f.delegated), false);
});
test('invalid base cannot silently become an empty diff', () => {
  const f = fixture();
  const r = run(f, ['--base', 'missing']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_candidate_unavailable:/);
  assert.equal(existsSync(f.delegated), false);
});
test('explicit head is the checked candidate even when checkout is ordinary', () => {
  const f = fixture();
  git(f.repo, 'switch', '-c', 'unpublished-verdict');
  write(f.repo, census, 'new verdict census\n');
  const head = commit(f.repo);
  git(f.repo, 'switch', 'integration');
  checker(f, 7);
  const r = run(f, ['--head', 'unpublished-verdict']);
  assert.equal(r.status, 7);
  const args = JSON.parse(readFileSync(f.checked));
  assert.equal(args.at(-1), head);
});
test('a tag with the same name cannot replace the explicit head branch', () => {
  const f = fixture();
  git(f.repo, 'tag', 'unpublished-verdict');
  git(f.repo, 'switch', '-c', 'unpublished-verdict');
  write(f.repo, census, 'new verdict census\n');
  const head = commit(f.repo);
  git(f.repo, 'switch', 'integration');
  checker(f, 7);
  assert.equal(run(f, ['--head', 'unpublished-verdict']).status, 7);
  assert.equal(JSON.parse(readFileSync(f.checked)).at(-1), head);
});
test('foreign owner-qualified head is refused instead of examining HEAD', () => {
  const f = fixture();
  const r = run(f, ['--head', 'other:integration']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^verdict_publish_candidate_unavailable:/);
  assert.equal(existsSync(f.delegated), false);
});
test('non-create reads do not inspect candidate Git state', () => {
  const f = fixture();
  const args = ['pr', 'view', '1398', '--repo', 'zts212653/clowder-ai'];
  const r = spawnSync(process.execPath, [guard, ...args], {
    cwd: f.root,
    encoding: 'utf8',
    env: { ...process.env, CAT_CAFE_REAL_GH_PATH: f.delegate, FIXTURE_DELEGATED: f.delegated },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.delegated)), args);
});
