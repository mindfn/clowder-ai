/**
 * F197 PR#1058 P1-2 regression: file path security for weixin-mp handlers.
 *
 * Upstream review P1: readLocalFile / writeLocalFile / convertMarkdown must
 * restrict paths to approved roots, reject symlink escapes, enforce size
 * limits, and always write generated output to tmpdir.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { PluginLimbAdapter } from '../dist/domains/limb/PluginLimbAdapter.js';
import { createWeixinMpHandlers, validateFilePath } from '../dist/plugins/weixin-mp/handlers.js';

// macOS: tmpdir() returns /var/folders/... but realpath resolves to /private/var/...
// Production code uses realpath on roots; tests must match.
let resolvedTmpdir;
before(async () => {
  resolvedTmpdir = await realpath(resolve(tmpdir()));
});

const WEIXIN_MP_LIMB_PATH = fileURLToPath(new URL('../src/plugins/weixin-mp/limbs/weixin-mp.yml', import.meta.url));

// ─── validateFilePath unit tests ────────────────────────────

describe('validateFilePath', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('allows path under an approved root', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-vfp-'));
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'hello');
    const result = await validateFilePath(filePath, [resolvedTmpdir], 'test');
    assert.equal(result, await realpath(filePath));
  });

  it('rejects path outside allowed roots', async () => {
    await assert.rejects(
      () => validateFilePath('/etc/passwd', [resolvedTmpdir], 'readLocalFile'),
      /path escapes allowed roots/,
    );
  });

  it('rejects relative path traversal (..)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-vfp-'));
    // Resolve tmpDir through realpath so we can create a valid traversal test
    const realTmpDir = await realpath(tmpDir);
    const traversal = join(realTmpDir, '..', '..', 'etc', 'passwd');
    await assert.rejects(
      () => validateFilePath(traversal, [realTmpDir], 'readLocalFile'),
      /path escapes allowed roots|parent directory does not exist/,
    );
  });

  it('rejects symlink escaping to outside root', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-vfp-'));
    const realTmpDir = await realpath(tmpDir);
    const linkPath = join(tmpDir, 'escape-link');
    await symlink('/etc', linkPath);
    const symlinkTarget = join(linkPath, 'passwd');
    await assert.rejects(
      () => validateFilePath(symlinkTarget, [realTmpDir], 'readLocalFile'),
      /path escapes allowed roots/,
    );
  });

  it('allows write path whose parent exists under root (new file)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-vfp-'));
    const newFile = join(tmpDir, 'new-output.html');
    // File doesn't exist yet — should resolve via parent
    const result = await validateFilePath(newFile, [resolvedTmpdir], 'writeLocalFile');
    assert.ok(result.startsWith(resolvedTmpdir));
  });

  it('rejects when parent directory does not exist', async () => {
    await assert.rejects(
      () => validateFilePath('/nonexistent-dir-abc123/file.txt', [resolvedTmpdir], 'test'),
      /parent directory does not exist/,
    );
  });
});

// ─── Handler-level security (via DI) ───────────────────────

describe('createWeixinMpHandlers path security', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSecureAdapter() {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const handlers = createWeixinMpHandlers();
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };
    return adapter;
  }

  it('convert_markdown reads from tmpdir and writes output to tmpdir', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-md-sec-'));
    const mdPath = join(tmpDir, 'article.md');
    await writeFile(mdPath, '# Security Test\n\nContent', 'utf-8');

    const adapter = makeSecureAdapter();
    const result = await adapter.invoke('weixin_mp.convert_markdown', {
      markdownFilePath: mdPath,
    });

    assert.equal(result.success, true, result.error);
    // Output must be in tmpdir, not derived from input path
    assert.ok(
      result.data.filePath.startsWith(tmpdir()),
      `Output path ${result.data.filePath} must be under tmpdir ${tmpdir()}`,
    );
    assert.match(result.data.filePath, /wx-converted-\d+\.html$/);
  });

  it('convert_markdown rejects reading files outside allowed roots', async () => {
    const adapter = makeSecureAdapter();
    const result = await adapter.invoke('weixin_mp.convert_markdown', {
      markdownFilePath: '/etc/passwd',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /path escapes allowed roots/);
  });

  it('create_draft rejects contentFilePath outside allowed roots', async () => {
    const adapter = makeSecureAdapter();
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'Test',
      thumbMediaId: 'thumb_001',
      contentFilePath: '/etc/shadow',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /path escapes allowed roots/);
  });
});

// ─── Size limit ─────────────────────────────────────────────

describe('readLocalFile size limit', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects files exceeding 2 MB text read limit', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-size-'));
    const bigFile = join(tmpDir, 'huge.md');
    // Write 2 MB + 1 byte to exceed the limit
    await writeFile(bigFile, Buffer.alloc(2 * 1024 * 1024 + 1, 'A'));

    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const handlers = createWeixinMpHandlers();
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };

    const result = await adapter.invoke('weixin_mp.convert_markdown', {
      markdownFilePath: bigFile,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /file too large/);
  });
});
