import { readMemberRequestRevision } from './helpers/member-request-revision.js';
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import Fastify from 'fastify';
import { bootstrapCatCatalog } from '../dist/config/cat-catalog-store.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { selectFakeCodexHome } from './helpers/fake-codex-home.js';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(apiRoot, '../web/src');

test('default selected recommendations create through the real API, including Kimi/Pi and partial retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-onboarding-api-'));
  const saved = new Map(
    [
      'CAT_TEMPLATE_PATH',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'KIMI_CONFIG_FILE',
      'OPENCODE_CONFIG',
      'PI_CODING_AGENT_DIR',
      'CODEX_HOME',
      'CODEX_SQLITE_HOME',
    ].map((key) => [key, process.env[key]]),
  );
  const restoreAuth = isolateAccountAuthEnvironment();
  const cwd = process.cwd();
  const app = Fastify();
  try {
    // Creating an enabled Codex member validates the native login independently of discovery.
    // Own this fixture too: never depend on the developer's credentials or CI's empty HOME.
    selectFakeCodexHome(root);
    // Bundle the production recommendation/payload functions: no copied request fixture or mocked POST success.
    const frontend = join(root, 'frontend.mjs');
    await build({
      stdin: {
        contents: `export { recommendNativePartners } from './components/first-run-quest/native-onboarding';
export { buildNativeCreationPayload } from './components/first-run-quest/native-creation-payload';`,
        resolveDir: webRoot,
      },
      outfile: frontend,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { '@': webRoot },
      logLevel: 'silent',
    });
    const { recommendNativePartners, buildNativeCreationPayload } = await import(pathToFileURL(frontend).href);
    const template = JSON.parse(await readFile(resolve(apiRoot, '../../cat-template.json'), 'utf8'));
    await mkdir(join(root, '.cat-cafe'));
    await writeFile(join(root, 'cat-template.json'), JSON.stringify(template));
    await writeFile(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify({ ...template, breeds: [] }));
    process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.KIMI_CONFIG_FILE = join(root, 'kimi.toml');
    process.env.OPENCODE_CONFIG = join(root, 'opencode.json');
    process.env.PI_CODING_AGENT_DIR = join(root, '.pi/agent');
    await writeFile(process.env.KIMI_CONFIG_FILE, 'default_model = "fixture-kimi"\n');
    await writeFile(process.env.OPENCODE_CONFIG, JSON.stringify({ model: 'fixture/model' }));
    const piBridgeEntry = join(root, 'fixture-pi-bridge.js');
    await writeFile(piBridgeEntry, '// test-owned bridge descriptor; no CLI execution');
    process.chdir(root);
    // The real host performs these legacy/owner migrations before accepting a
    // create request. Establish that precondition before checking byte stability.
    bootstrapCatCatalog(root, join(root, 'cat-template.json'));
    const runtimes = [
      { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] },
      { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [] },
      {
        id: 'dsh',
        label: 'DSH',
        clientId: 'acp',
        installed: true,
        models: [],
        acp: { command: 'node', startupArgs: ['fixture-dsh.js', '--profile', 'acp'] },
      },
      ...discoverAdditionalRuntimes(root, (command) => (command === 'pi-acp' ? null : process.execPath), {
        piBridgeEntry,
      }),
    ];
    await app.register(catsRoutes, { nativeRuntimeDiscovery: async () => ({ runtimes }) });
    const headers = { 'x-cat-cafe-user': 'default-user', 'x-cat-cafe-onboarding-journey': randomUUID() };
    const templates = (await app.inject({ url: '/api/cat-templates', headers })).json().templates;
    assert.ok(templates.length > 0);
    const partners = recommendNativePartners(runtimes, templates, [], headers['x-cat-cafe-onboarding-journey']);
    const selected = partners.filter((partner) => partner.selected);
    assert.deepEqual(
      selected.map((p) => p.runtime.clientId),
      ['openai', 'anthropic', 'acp', 'kimi', 'acp'],
    );
    const requests = selected.map((partner) => ({
      method: 'POST',
      url: '/api/cats',
      headers: {
        ...headers,
        'idempotency-key': `onboarding:${headers['x-cat-cafe-onboarding-journey']}:cat:${partner.creationRequestKey}`,
      },
      payload: buildNativeCreationPayload(partner.form),
    }));
    const manualHeaders = { 'x-cat-cafe-user': 'default-user' };
    for (const clientId of ['google', 'catagent']) {
      const rejected = await app.inject({
        ...requests[0],
        headers: manualHeaders,
        payload: {
          ...requests[0].payload,
          catId: `unsupported-${clientId}`,
          clientId,
          carrier: 'cli',
          mentionPatterns: [`@unsupported-${clientId}`],
        },
      });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.match(rejected.json().error, /暂不支持本机工具模式/);
    }
    const managed = await app.inject({
      ...requests[3],
      headers: manualHeaders,
      payload: {
        ...requests[3].payload,
        catId: 'managed-kimi',
        configurationSource: 'managed_account',
        mentionPatterns: ['@managed-kimi'],
      },
    });
    assert.equal(managed.statusCode, 400);
    assert.match(managed.json().error, /requires a provider binding/);
    const cloud = await app.inject({
      ...requests[0],
      headers: manualHeaders,
      payload: {
        ...requests[0].payload,
        catId: 'cloud-native',
        provider: 'openai-chatgpt-pro',
        mentionPatterns: ['@cloud-native'],
      },
    });
    assert.equal(cloud.statusCode, 400);
    assert.match(cloud.json().error, /云端成员不能使用本机工具模式/);
    const loggedInHome = process.env.CODEX_HOME;
    const unchanged = await readFile(join(root, '.cat-cafe/cat-catalog.json'), 'utf8');
    try {
      process.env.CODEX_HOME = join(root, 'missing-native-login');
      const unavailable = await app.inject(requests[0]);
      assert.equal(unavailable.statusCode, 400, unavailable.body);
      assert.match(unavailable.json().error, /本机默认号未登录或读不到/);
      assert.equal(await readFile(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), unchanged);
    } finally {
      process.env.CODEX_HOME = loggedInHome;
    }
    // First three are already committed when a user continues after the old fourth-request failure.
    for (const request of requests.slice(0, 3)) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 201, response.body);
    }
    const before = await readFile(join(root, '.cat-cafe/cat-catalog.json'), 'utf8');
    const createdIds = new Map();
    for (const request of requests.slice(3)) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 201, `${request.payload.clientId}: ${response.body}`);
      const createdId = response.json().cat.id;
      createdIds.set(request.payload.clientId, createdId);
      assert.equal(response.json().cat.defaultModel, '');
      assert.equal(response.json().cat.accountRef, undefined);
      assert.equal(response.json().cat.cli.effort, undefined);
      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${createdId}`,
        headers,
        payload: {
          expectedRevision: await readMemberRequestRevision(app, `/api/cats/${createdId}`, headers),
          nickname: 'custom native nickname',
          defaultModel: 'fixture/override',
        },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      const reset = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${createdId}`,
        headers,
        payload: {
          expectedRevision: await readMemberRequestRevision(app, `/api/cats/${createdId}`, headers),
          defaultModel: '',
          cli: { effort: null },
        },
      });
      assert.equal(reset.statusCode, 200, reset.body);
    }
    const after = JSON.parse(await readFile(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'));
    for (const breed of JSON.parse(before).breeds) {
      assert.deepEqual(
        after.breeds.find((entry) => entry.catId === breed.catId),
        breed,
        'existing members must not change',
      );
    }
    const expectedBreedCount = JSON.parse(before).breeds.length + 2;
    assert.equal(after.breeds.length, expectedBreedCount);
    const readback = await app.inject({ url: '/api/cats', headers });
    assert.equal(readback.statusCode, 200, readback.body);
    for (const clientId of ['kimi', 'acp']) {
      const cat = readback.json().cats.find((entry) => entry.id === createdIds.get(clientId));
      assert.equal(cat.configurationSource, 'native_tool');
      assert.equal(cat.defaultModel, '');
      assert.equal(cat.nickname, 'custom native nickname');
    }
    assert.equal(
      readback.json().cats.find((entry) => entry.id === createdIds.get('kimi')).avatar,
      '/avatars/family/kimi.png',
      'Kimi keeps its family avatar after the API readback',
    );
    assert.equal(
      readback.json().cats.find((entry) => entry.id === createdIds.get('acp')).avatar,
      '/avatars/family/opencode.png',
      'Pi keeps its dedicated fallback avatar after the API readback',
    );
    // Replaying an unchanged committed request must not add a duplicate.
    for (const request of requests.slice(0, 3)) assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal(
      JSON.parse(await readFile(join(root, '.cat-cafe/cat-catalog.json'), 'utf8')).breeds.length,
      expectedBreedCount,
    );
    assert.equal(
      recommendNativePartners(runtimes, templates, readback.json().cats, randomUUID()).filter((p) => p.existingId)
        .length,
      5,
    );
  } finally {
    await app.close();
    process.chdir(cwd);
    restoreAuth();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('discovered AGY Native creates through the real API with managed_account and reads back on refresh while plain Google native_tool stays rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-onboarding-agy-'));
  const saved = new Map(
    ['CAT_TEMPLATE_PATH', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_CONFIG_ROOT', 'CODEX_HOME', 'CODEX_SQLITE_HOME'].map(
      (key) => [key, process.env[key]],
    ),
  );
  const restoreAuth = isolateAccountAuthEnvironment();
  const cwd = process.cwd();
  const app = Fastify();
  try {
    selectFakeCodexHome(root);
    const frontend = join(root, 'frontend-agy.mjs');
    await build({
      stdin: {
        contents: `export { recommendNativePartners } from './components/first-run-quest/native-onboarding';
export { buildNativeCreationPayload } from './components/first-run-quest/native-creation-payload';`,
        resolveDir: webRoot,
      },
      outfile: frontend,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { '@': webRoot },
      logLevel: 'silent',
    });
    const { recommendNativePartners, buildNativeCreationPayload } = await import(pathToFileURL(frontend).href);
    const { accountsRoutes } = await import('../dist/routes/accounts.js');
    const template = JSON.parse(await readFile(resolve(apiRoot, '../../cat-template.json'), 'utf8'));
    await mkdir(join(root, '.cat-cafe'));
    await writeFile(join(root, 'cat-template.json'), JSON.stringify(template));
    await writeFile(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify({ ...template, breeds: [] }));
    process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.chdir(root);
    bootstrapCatCatalog(root, join(root, 'cat-template.json'));

    const runtimes = [
      {
        id: 'agy-native',
        label: 'AGY Native',
        clientId: 'google',
        agyCarrier: 'native',
        installed: true,
        models: [],
      },
    ];
    await app.register(catsRoutes, { nativeRuntimeDiscovery: async () => ({ runtimes }) });
    await app.register(accountsRoutes);

    const headers = { 'x-cat-cafe-user': 'default-user', 'x-cat-cafe-onboarding-journey': randomUUID() };
    const templates = (await app.inject({ url: '/api/cat-templates', headers })).json().templates;

    // 1. Create a standalone AGY OAuth account via real /api/accounts; before login it must NOT be selectable.
    const createdAccount = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: { projectPath: root, authType: 'oauth', clientId: 'google', displayName: 'Work AGY', agyOAuth: true },
    });
    assert.equal(createdAccount.statusCode, 200, createdAccount.body);
    const agyAccount = createdAccount.json().profile;
    assert.equal(agyAccount.agyLoginStatus, 'not_logged_in');

    const unloggedAccountsRes = await app.inject({
      url: `/api/accounts?projectPath=${encodeURIComponent(root)}`,
      headers,
    });
    assert.equal(unloggedAccountsRes.statusCode, 200, unloggedAccountsRes.body);
    const unloggedAccountsBody = unloggedAccountsRes.json();
    // Filter out built-in synthetic accounts if any to prove unlogged standalone AGY is rejected on its own.
    const blockedPartners = recommendNativePartners(runtimes, templates, [], headers['x-cat-cafe-onboarding-journey'], {
      accounts: unloggedAccountsBody.providers.filter((p) => p.id === agyAccount.id),
      projectPath: unloggedAccountsBody.projectPath,
    });
    assert.equal(blockedPartners.length, 1);
    assert.equal(blockedPartners[0].selected, false);
    assert.equal(blockedPartners[0].accountRequired, true);
    assert.equal(blockedPartners[0].form.configurationSource, 'managed_account');

    // 2. Complete standalone AGY login (refreshable token file) and re-discover.
    const tokenPath = join(agyAccount.agy.credentialHome, '.gemini/antigravity-cli/antigravity-oauth-token');
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(
      tokenPath,
      JSON.stringify({
        token: { access_token: 'TEST-ACCESS', refresh_token: 'TEST-REFRESH', expiry: '2000-01-01T00:00:00Z' },
        auth_method: 'consumer',
      }),
      { mode: 0o600 },
    );
    const accountsRes = await app.inject({
      url: `/api/accounts?projectPath=${encodeURIComponent(root)}`,
      headers,
    });
    assert.equal(accountsRes.statusCode, 200, accountsRes.body);
    const accountsBody = accountsRes.json();

    const partners = recommendNativePartners(runtimes, templates, [], headers['x-cat-cafe-onboarding-journey'], {
      accounts: accountsBody.providers,
      projectPath: accountsBody.projectPath,
    });
    assert.equal(partners.length, 1);
    const agyPartner = partners[0];
    assert.equal(agyPartner.selected, true);
    assert.equal(agyPartner.form.configurationSource, 'managed_account');
    assert.equal(agyPartner.form.accountRef, agyAccount.id);
    assert.equal(agyPartner.form.agyAutoApprove, false, 'must preserve restricted autoApprove=false');
    assert.equal(agyPartner.form.agyTrustedWorkspaces, accountsBody.projectPath);

    // 2. Fill real required model ID (without requiring cli.effort) and submit to POST /api/cats.
    agyPartner.form.defaultModel = 'gemini-3.8-flash-high';
    const payload = buildNativeCreationPayload(agyPartner.form);
    assert.equal(payload.clientId, 'google');
    assert.equal(payload.carrier, 'cli');
    assert.equal(payload.configurationSource, 'managed_account');
    assert.equal(payload.accountRef, agyPartner.form.accountRef);
    assert.equal(payload.defaultModel, 'gemini-3.8-flash-high');
    assert.equal(payload.cli, undefined, 'cli.effort must remain optional');
    assert.deepEqual(payload.agyProfile, {
      enabled: true,
      carrier: 'native',
      profileId: agyPartner.form.catId,
      model: 'gemini-3.8-flash-high',
      autoApprove: false,
      trustedWorkspaces: [accountsBody.projectPath],
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        ...headers,
        'idempotency-key': `onboarding:${headers['x-cat-cafe-onboarding-journey']}:cat:${agyPartner.creationRequestKey}`,
      },
      payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdCat = created.json().cat;
    assert.equal(createdCat.clientId, 'google');
    assert.equal(createdCat.carrier, 'cli');
    assert.equal(createdCat.configurationSource, 'managed_account');
    assert.equal(createdCat.accountRef, agyPartner.form.accountRef);
    assert.equal(createdCat.defaultModel, 'gemini-3.8-flash-high');
    assert.deepEqual(createdCat.agyProfile, payload.agyProfile);

    // 3. Refresh via GET /api/cats and verify model, identity/Profile and permissions stay consistent.
    const readback = await app.inject({ url: '/api/cats', headers });
    assert.equal(readback.statusCode, 200, readback.body);
    const persisted = readback.json().cats.find((cat) => cat.id === createdCat.id);
    assert.ok(persisted);
    assert.equal(persisted.configurationSource, 'managed_account');
    assert.equal(persisted.accountRef, agyPartner.form.accountRef);
    assert.equal(persisted.defaultModel, 'gemini-3.8-flash-high');
    assert.deepEqual(persisted.agyProfile, payload.agyProfile);

    // Re-running discovery after refresh recognizes the created AGY Native member.
    const refreshedPartners = recommendNativePartners(runtimes, templates, readback.json().cats, randomUUID(), {
      accounts: accountsBody.providers,
      projectPath: accountsBody.projectPath,
    });
    assert.equal(refreshedPartners[0].existingId, createdCat.id);

    // 4. Plain Google native_tool (without AGY Native or with native_tool) is still rejected by backend.
    const rejectedPlainGoogle = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: {
        catId: 'plain-google-native-tool',
        name: 'Plain Google',
        displayName: 'Plain Google',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@plain-google'],
        roleDescription: 'test',
        clientId: 'google',
        carrier: 'cli',
        configurationSource: 'native_tool',
        defaultModel: 'gemini-3.8-flash-high',
      },
    });
    assert.equal(rejectedPlainGoogle.statusCode, 400, rejectedPlainGoogle.body);
    assert.match(rejectedPlainGoogle.json().error, /暂不支持本机工具模式/);
  } finally {
    await app.close();
    process.chdir(cwd);
    restoreAuth();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
