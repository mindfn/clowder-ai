import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import identity from './lib/build-identity.cjs';

const launcher = resolve('scripts/start-dev.sh');
const artifacts = {
  shared: 'dist/index.js',
  'mcp-server': 'dist/index.js',
  api: 'dist/index.js',
  web: '.next/BUILD_ID',
};
const stamp = (root, pkg) => join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist', '.build-commit');

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture({ versioned = true } = {}) {
  // Retained isolated source/build fixtures contain no persistent user data.
  const root = mkdtempSync(join(tmpdir(), 'f117-build-identity-'));
  writeFileSync(join(root, '.gitignore'), '**/dist/\n**/.next/\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'tsconfig.base.json'), '{}\n');
  mkdirSync(join(root, 'packages', 'collective-service', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'collective-service', 'src', 'index.ts'), 'export const version = 1;\n');
  for (const [pkg, product] of Object.entries(artifacts)) {
    mkdirSync(join(root, 'packages', pkg, 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', pkg, 'src', 'index.ts'), 'export const version = 1;\n');
    mkdirSync(join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', pkg, product), 'old product\n');
    writeFileSync(stamp(root, pkg), `${'a'.repeat(40)}\n`);
  }
  if (!versioned) return { root, head: null };
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial source');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

function build(root, { prod = true, fail = '', mutation = '', quick = false, noProduct = false } = {}) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
source "$LAUNCHER" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
PROJECT_DIR="$FIXTURE_ROOT"
PROD_WEB="$BUILD_PROD"
QUICK_MODE="$BUILD_QUICK"
run_logged_step() {
  local pkg="\${4##*/}"
  printf '%s:%s\\n' "$pkg" "\${CAT_CAFE_WEB_BUILD_REVISION:-}" >> "$PROJECT_DIR/build-calls.log"
  [ "$pkg" != "$BUILD_FAIL" ] || return 17
  [ "$BUILD_NO_PRODUCT" != true ] || return 0
  if [ "$pkg" = web ]; then
    printf 'built\\n' > "$PROJECT_DIR/packages/web/.next/BUILD_ID"
    # Model the existing postbuild writer, including stale/incorrect stamps.
    printf '%s\\n' "\${CAT_CAFE_WEB_BUILD_REVISION:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" > "$PROJECT_DIR/packages/web/.next/.build-commit"
  else
    printf 'built\\n' > "$PROJECT_DIR/packages/$pkg/dist/index.js"
  fi
  if [ "$pkg" = api ]; then
    case "$BUILD_MUTATION" in
      head) git -C "$PROJECT_DIR" -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty -qm moved ;;
      tracked) printf 'changed\\n' >> "$PROJECT_DIR/packages/api/src/index.ts" ;;
      root_config) printf ' \\n' >> "$PROJECT_DIR/tsconfig.base.json" ;;
      workspace_dependency) printf 'changed\\n' >> "$PROJECT_DIR/packages/collective-service/src/index.ts" ;;
      untracked) printf 'new\\n' > "$PROJECT_DIR/packages/shared/src/new.ts" ;;
      transient_file) printf 'export const transient = 99;\\n' > "$PROJECT_DIR/packages/api/src/transient.ts"; cp "$PROJECT_DIR/packages/api/src/transient.ts" "$PROJECT_DIR/packages/api/dist/transient.js"; mv "$PROJECT_DIR/packages/api/src/transient.ts" "$PROJECT_DIR/retained-transient.ts" ;;
      transient_directory) mkdir "$PROJECT_DIR/packages/api/src/transient"; printf 'export const transient = 99;\\n' > "$PROJECT_DIR/packages/api/src/transient/index.ts"; cp "$PROJECT_DIR/packages/api/src/transient/index.ts" "$PROJECT_DIR/packages/api/dist/transient.js"; mv "$PROJECT_DIR/packages/api/src/transient" "$PROJECT_DIR/retained-transient" ;;
      generated_namespace) mkdir -p "$PROJECT_DIR/packages/api/dist/new-directory"; printf 'generated\\n' > "$PROJECT_DIR/packages/api/dist/new-directory/generated.js"; mv "$PROJECT_DIR/packages/api/dist/new-directory" "$PROJECT_DIR/retained-generated" ;;
      restored) cp "$PROJECT_DIR/packages/api/src/index.ts" "$PROJECT_DIR/original.ts"; printf 'transient\\n' >> "$PROJECT_DIR/packages/api/src/index.ts"; cp "$PROJECT_DIR/original.ts" "$PROJECT_DIR/packages/api/src/index.ts" ;;
      head_restored) local old_head; old_head=$(git -C "$PROJECT_DIR" rev-parse HEAD); git -C "$PROJECT_DIR" -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty -qm moved; git -C "$PROJECT_DIR" update-ref -m returned HEAD "$old_head" ;;
    esac
  fi
  if [ "$pkg" = web ] && [ "$BUILD_MUTATION" = signal ]; then
    terminate_managed_pids() { :; }
    remove_redis_dev_lease() { :; }
    USE_REDIS=false
    F247_CLOUD_OWNER_FILE=""
    DAEMON_PID_FILE="$PROJECT_DIR/no-daemon.pid"
    trap 'trap - EXIT; cleanup; exit 143' TERM
    kill -TERM $$
  fi
}
if [ "$QUICK_MODE" = false ]; then build_packages; fi
`,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'dumb',
        LAUNCHER: launcher,
        FIXTURE_ROOT: root,
        BUILD_PROD: String(prod),
        BUILD_FAIL: fail,
        BUILD_MUTATION: mutation,
        BUILD_QUICK: String(quick),
        BUILD_NO_PRODUCT: String(noProduct),
      },
    },
  );
  return result;
}

test('normal successful production build publishes one exact API/Web identity and pins the bundle revision', () => {
  const { root, head } = fixture();
  const result = build(root);
  assert.equal(result.status, 0, result.stderr);
  for (const pkg of Object.keys(artifacts)) assert.equal(readFileSync(stamp(root, pkg), 'utf8').trim(), head);
  assert.match(readFileSync(join(root, 'build-calls.log'), 'utf8'), new RegExp(`web:${head}`));
});

for (const fail of ['shared', 'mcp-server', 'api', 'web']) {
  test(`failed ${fail} build invalidates old deployment stamps, including partial output`, () => {
    const { root } = fixture();
    const result = build(root, { fail });
    assert.equal(result.status, 17, result.stderr);
    for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
  });
}

for (const mutation of [
  'head',
  'tracked',
  'root_config',
  'workspace_dependency',
  'untracked',
  'transient_file',
  'transient_directory',
  'restored',
  'head_restored',
]) {
  test(`${mutation} changes during compilation cannot publish current HEAD as build identity`, () => {
    const { root } = fixture();
    const result = build(root, { mutation });
    assert.equal(result.status, 0, result.stderr);
    for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
  });
}

test('generated output namespace changes do not invalidate an otherwise clean build', () => {
  const { root, head } = fixture();
  assert.equal(build(root, { mutation: 'generated_namespace' }).status, 0);
  for (const pkg of Object.keys(artifacts)) assert.equal(readFileSync(stamp(root, pkg), 'utf8').trim(), head);
});

test('fresh output directories are established before the source namespace observation', () => {
  const { root, head } = fixture();
  for (const pkg of Object.keys(artifacts)) {
    renameSync(join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist'), join(root, `retained-${pkg}`));
  }
  assert.equal(build(root).status, 0);
  for (const pkg of Object.keys(artifacts)) assert.equal(readFileSync(stamp(root, pkg), 'utf8').trim(), head);
});

test('a real TypeScript compile of added-then-moved source cannot receive the original committed identity', () => {
  const { root, head } = fixture();
  const context = identity.beginBuildIdentity(root);
  const transient = join(root, 'packages/api/src/transient.ts');
  writeFileSync(transient, 'export const transient = 99;\n');
  const compiler = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/lib/tsc.js'),
      '--target',
      'es2022',
      '--skipLibCheck',
      '--outDir',
      join(root, 'packages/api/dist'),
      join(root, 'packages/api/src/index.ts'),
      transient,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(compiler.status, 0, compiler.stdout + compiler.stderr);
  assert.match(readFileSync(join(root, 'packages/api/dist/transient.js'), 'utf8'), /transient = 99/);
  renameSync(transient, join(root, 'retained-transient.ts'));
  for (const [pkg, product] of Object.entries(artifacts))
    writeFileSync(join(root, 'packages', pkg, product), 'built\n');
  writeFileSync(stamp(root, 'web'), `${head}\n`);
  assert.equal(git(root, 'status', '--porcelain', '--', ...identity.INPUTS), '');
  assert.equal(identity.finishBuildIdentity(root, context, Object.keys(artifacts)), false);
  for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
});

test('dirty inputs at build start cannot be legitimized by successful compilation', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'packages/api/src/index.ts'), 'dirty\n');
  const result = build(root);
  assert.equal(result.status, 0, result.stderr);
  for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
});

test('partial dev build never relabels the retained old Web artifact', () => {
  const { root, head } = fixture();
  const result = build(root, { prod: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(stamp(root, 'api'), 'utf8').trim(), head);
  assert.equal(existsSync(stamp(root, 'web')), false);
});

test('quick mode skips compilation and does not stamp old products with current HEAD', () => {
  const { root } = fixture();
  assert.equal(build(root, { quick: true }).status, 0);
  assert.equal(existsSync(join(root, 'build-calls.log')), false);
  for (const pkg of Object.keys(artifacts)) assert.equal(readFileSync(stamp(root, pkg), 'utf8').trim(), 'a'.repeat(40));
});

test('a successful command that produced nothing cannot bless old products with a new HEAD', () => {
  const { root } = fixture();
  assert.equal(build(root, { noProduct: true }).status, 0);
  for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
});

test('unversioned sources may build but cannot manufacture a trusted deployment revision', () => {
  const { root } = fixture({ versioned: false });
  assert.equal(build(root).status, 0);
  for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
});

test('SIGTERM after Web postbuild invalidates intermediate stamps through the actual cleanup handler', () => {
  const { root } = fixture();
  assert.equal(build(root, { mutation: 'signal' }).status, 143);
  for (const pkg of Object.keys(artifacts)) assert.equal(existsSync(stamp(root, pkg)), false, pkg);
});

test('main only enters the build transaction when quick mode is disabled', () => {
  assert.match(readFileSync(launcher, 'utf8'), /if \[ "\$QUICK_MODE" = false \]; then\s+build_packages\s+else/);
});
