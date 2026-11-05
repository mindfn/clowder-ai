import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { build } from 'vite';
import { readPluginConfig } from '../../../api/src/domains/plugin/plugin-config-store.ts';
import { registerPluginManagerRoutes } from '../../../api/src/routes/plugin-manager-routes.ts';
import { pluginSkillLifecycleFixture } from '../../../api/test/helpers/plugin-skill-lifecycle-fixture.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceDir = process.env.PLUGIN_1727_EVIDENCE_DIR;

// with-test-home isolates user configuration; the installed browser executable is a shared read-only asset.
if (process.env.CAT_CAFE_TEST_REAL_HOME && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const home = process.env.CAT_CAFE_TEST_REAL_HOME;
  const cache =
    process.platform === 'darwin'
      ? path.join(home, 'Library/Caches')
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'))
        : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(cache, 'ms-playwright');
}
const { chromium } = await import('playwright');

async function capture(page, name) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
}

async function buildSurface() {
  const startDir = process.cwd();
  let outputs;
  try {
    process.chdir(webRoot);
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': '""' },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/plugin-lifecycle-1727.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  } finally {
    process.chdir(startDir);
  }
  const script = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
  const css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  return { script, css };
}

// Production component, transport, REST guards, Manager, package/inventory/config stores and mounts.
// Only session establishment and the empty remote catalog are fixture boundaries. No live Redis/service.
test('current fork: browser conflict recovery, restart and uninstall/reinstall preserve owner content', async () => {
  const fixture = await pluginSkillLifecycleFixture();
  const app = Fastify();
  let browser;
  let page;
  const requests = [];
  const audits = [];
  const errors = [];
  const failures = [];
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  try {
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = owner;
      if (request.url.startsWith('/api/')) requests.push(`${request.method} ${request.url}`);
    });
    app.get('/api/session', async () => ({ userId: owner, csrfToken: 'isolated-fixture-csrf' }));
    app.get('/api/agent-providers', async () => ({ providers: [] }));
    app.post('/api/plugin-manager/marketplaces/refresh', async () => ({ sources: [] }));
    registerPluginManagerRoutes(app, {
      manager: fixture.manager,
      asset: fixture.assets,
      documentation: fixture.assets,
      contributions: fixture.runtime.supervisor,
      auditLog: { append: async (event) => audits.push(event) },
    });
    const { script, css } = await buildSurface();
    app.get('/proof.js', async (_request, reply) => reply.type('text/javascript').send(script));
    app.get('/proof.css', async (_request, reply) => reply.type('text/css').send(css));
    app.get('/', async (request, reply) =>
      reply
        .type('text/html')
        .send(
          `<!doctype html><html data-cat-cafe-api-origin="http://${request.headers.host}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"></head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>`,
        ),
    );
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const current = () => fixture.manager.getLocal(fixture.pluginId).then((value) => value.plugin);
    const initial = await current();
    await fixture.manager.configure(fixture.pluginId, {
      expectedRevision: initial.lifecycleRevision,
      updates: [{ key: 'NOTE', value: 'owner configuration must survive' }],
    });
    const configBefore = await readFile(
      path.join(fixture.root, '.cat-cafe/plugin-config', `${fixture.pluginId}.json`),
      'utf8',
    );
    const dataDir = path.join(fixture.root, '.cat-cafe/plugin-data', fixture.pluginId);
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'owner-record.json'), '{"message":"retained owner data"}\n');
    const assertRetained = async () => {
      assert.equal(
        await readFile(path.join(fixture.root, '.cat-cafe/plugin-config', `${fixture.pluginId}.json`), 'utf8'),
        configBefore,
      );
      assert.equal(readPluginConfig(fixture.root, fixture.pluginId).NOTE, 'owner configuration must survive');
      assert.equal(
        await readFile(path.join(dataDir, 'owner-record.json'), 'utf8'),
        '{"message":"retained owner data"}\n',
      );
    };
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 400)
        failures.push(`${response.status()} ${response.url()}`);
    });
    await page.route('**/*', async (route) => {
      assert.equal(new URL(route.request().url()).origin, origin, 'no request may escape the isolated Host');
      await route.continue();
    });
    await page.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
    });
    const openDetail = async () => {
      await page.goto(`${origin}/?plugin=${fixture.pluginId}`);
      await page.getByTestId('plugin-manager-detail').waitFor();
    };
    await openDetail();
    const detail = page.getByTestId('plugin-manager-detail');
    await detail.getByRole('button', { name: '启用插件生命周期验收', exact: true }).click();
    await page.locator('[data-plugin-skill-conflicts]').waitFor();
    assert.equal((await current()).intent, 'enabled');
    assert.equal((await current()).activationFailed, undefined);
    // A distinct contribution really mounts while guide is blocked; this is not just UI wording.
    assert.equal(
      await readFile(path.join(fixture.root, '.codex/skills/helper/SKILL.md'), 'utf8'),
      '# Uncontested plugin helper\n',
    );
    assert.equal(
      await readFile(path.join(fixture.root, '.claude/skills/guide/SKILL.md'), 'utf8'),
      '# Fixture plugin guide\n',
    );
    assert.equal(
      await readFile(path.join(fixture.root, '.codex/skills/guide/user.md'), 'utf8'),
      'User-owned content must survive.',
    );
    await capture(page, 'conflict-desktop.png');
    await page.getByRole('button', { name: '使用此插件技能…', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '使用插件技能', exact: true }).click();
    await page.getByText('原内容已保留于', { exact: false }).waitFor();
    assert.deepEqual((await current()).skillConflicts, []);
    const backup = (await readdir(path.join(fixture.root, '.codex/skills'))).find((name) => name.includes('backup'));
    assert.ok(backup, 'source replacement retains a unique local backup');
    const assertBackup = async () =>
      assert.equal(
        await readFile(path.join(fixture.root, '.codex/skills', backup, 'user.md'), 'utf8'),
        'User-owned content must survive.',
      );
    await assertBackup();
    const revisionBefore = (await current()).lifecycleRevision;
    const restarted = page.waitForResponse(
      (response) => response.url().endsWith('/restart') && response.request().method() === 'POST',
    );
    await detail.locator('[data-plugin-detail-action="restart"]').click();
    assert.equal((await restarted).status(), 200);
    assert.ok((await current()).lifecycleRevision > revisionBefore);
    assert.equal((await current()).activationFailed, undefined);
    await assertRetained();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await detail.getByText('验收说明 30', { exact: false }).scrollIntoViewIfNeeded();
      for (const action of ['[data-plugin-uninstall]', '[data-plugin-detail-action="restart"]']) {
        const box = await detail.locator(action).boundingBox();
        assert.ok(
          box && box.y >= 0 && box.y + box.height <= (width === 390 ? 844 : 800),
          `${action} remains reachable at ${width}px`,
        );
      }
      const titleReadable = await detail.locator('header h3').evaluate((title) => {
        const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
        return title.getBoundingClientRect().height <= lineHeight * 3;
      });
      assert.equal(titleReadable, true, 'mobile actions must leave room for a readable plugin name');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await capture(page, `resolved-${width}.png`);
    }
    await detail.locator('[data-plugin-uninstall]').click();
    const uninstalled = page.waitForResponse(
      (response) => response.url().endsWith('/uninstall') && response.request().method() === 'POST',
    );
    await page.getByRole('dialog').getByRole('button', { name: '卸载', exact: true }).click();
    assert.equal((await uninstalled).status(), 200);
    assert.deepEqual((await fixture.manager.listLocal()).plugins, []);
    await assertRetained();
    await assertBackup();
    // Local directory admission is the real REST endpoint; the OS directory picker is outside this test.
    const installed = await page.evaluate(async (packageRoot) => {
      const response = await fetch('/api/plugin-manager/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { kind: 'local-directory', path: packageRoot } }),
      });
      return { status: response.status, body: await response.json() };
    }, fixture.packageRoot);
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
    await openDetail();
    await detail.getByRole('button', { name: '启用插件生命周期验收', exact: true }).click();
    await detail.getByRole('button', { name: '禁用插件生命周期验收', exact: true }).waitFor();
    assert.equal((await current()).intent, 'enabled');
    assert.equal((await current()).activationFailed, undefined);
    assert.deepEqual((await current()).skillConflicts, []);
    await assertRetained();
    await assertBackup();
    assert.equal(
      await readFile(path.join(fixture.root, '.codex/skills/helper/SKILL.md'), 'utf8'),
      '# Uncontested plugin helper\n',
    );
    assert.ok(audits.length >= 5, 'mutations reach the real audit boundary');
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    if (evidenceDir)
      await writeFile(
        path.join(evidenceDir, 'journey.json'),
        JSON.stringify(
          {
            requests,
            audits,
            errors,
            failures,
            final: await current(),
            retention: 'configuration bytes, fixture file data, user skill backup, second skill mount',
          },
          null,
          2,
        ),
      );
  } catch (error) {
    console.error(JSON.stringify({ requests, errors, failures, body: await page?.locator('body').innerText() }));
    throw error;
  } finally {
    await browser?.close();
    await app.close();
    await fixture.close();
  }
});
