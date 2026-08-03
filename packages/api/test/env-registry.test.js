/**
 * F12: env-registry + GET /api/config/env-summary tests
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  buildEnvSummary,
  buildSystemEnvSummary,
  ENV_CATEGORIES,
  ENV_VARS,
  hasSensitiveEditableVars,
  isEditableEnvVar,
  isSensitiveEditableEnvVar,
  maskUrlCredentials,
  parseBoolEnv,
  SYSTEM_VARS,
  validateEnvValue,
} from '../dist/config/env-registry.js';
import { MAX_CLI_TIMEOUT_MS } from '../dist/utils/cli-timeout.js';

// Save and restore env vars around tests
const savedEnv = {};
// NEXT_PUBLIC_* vars are bootstrap-only (runtimeEditable omitted = not editable).
// PATCH route tests below verify rejection from hub writes.
const BOOTSTRAP_ONLY_NEXT_PUBLIC_VARS = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_WHISPER_URL',
  'NEXT_PUBLIC_LLM_POSTPROCESS_URL',
  'NEXT_PUBLIC_PROJECT_ROOT',
  'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI',
];

function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('env-registry', () => {
  afterEach(() => restoreEnv());

  it('exports at least 20 env var definitions', () => {
    assert.ok(ENV_VARS.length >= 20, `Expected >= 20, got ${ENV_VARS.length}`);
  });

  it('has no duplicate env var names', () => {
    const names = ENV_VARS.map((v) => v.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Duplicate names found: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('every env var has a valid category', () => {
    const validCategories = Object.keys(ENV_CATEGORIES);
    for (const def of ENV_VARS) {
      assert.ok(validCategories.includes(def.category), `${def.name} has invalid category: ${def.category}`);
    }
  });

  it('GITHUB_WEBHOOK_SECRET is marked sensitive', () => {
    const def = ENV_VARS.find((v) => v.name === 'GITHUB_WEBHOOK_SECRET');
    assert.ok(def, 'GITHUB_WEBHOOK_SECRET should be in registry');
    assert.equal(def.sensitive, true);
  });

  it('exposes official quota credential configuration in Hub as editable (restart-required)', () => {
    const summaryNames = new Set(buildEnvSummary().map((entry) => entry.name));
    for (const name of ['QUOTA_OFFICIAL_REFRESH_ENABLED', 'CLAUDE_CREDENTIALS_PATH', 'CODEX_CREDENTIALS_PATH']) {
      const def = ENV_VARS.find((entry) => entry.name === name);
      assert.ok(def, `${name} should be registered`);
      assert.ok(summaryNames.has(name), `${name} should be visible in Hub`);
      assert.equal(def.runtimeEditable, true, `${name} must be editable from System Settings`);
      assert.equal(def.restartRequired, true, `${name} takes effect after restart`);
    }
  });

  it('REDIS_URL has maskMode url', () => {
    const redis = ENV_VARS.find((v) => v.name === 'REDIS_URL');
    assert.ok(redis, 'REDIS_URL should be in registry');
    assert.equal(redis.maskMode, 'url');
  });

  it('API_SERVER_PORT is editable with restart required and port constraint', () => {
    const def = ENV_VARS.find((v) => v.name === 'API_SERVER_PORT');
    assert.ok(def, 'API_SERVER_PORT should be in registry');
    assert.equal(def.runtimeEditable, true, 'API_SERVER_PORT must be editable from System Settings');
    assert.equal(def.restartRequired, true, 'API_SERVER_PORT binds at startup — requires restart');
    assert.deepEqual(def.numericConstraint, { min: 1, max: 65535 }, 'port range constraint');
  });

  it('accepts both API_SERVER_PORT and PREVIEW_GATEWAY_PORT from hub writes', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'API_SERVER_PORT=3003\nPREVIEW_GATEWAY_PORT=4100\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Both port vars are now editable (save to .env, restart to take effect)
      const apiPortRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'API_SERVER_PORT', value: '3203' }],
        },
      });
      assert.equal(apiPortRes.statusCode, 200, 'API_SERVER_PORT should be accepted');

      const previewPortRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'PREVIEW_GATEWAY_PORT', value: '4200' }],
        },
      });
      assert.equal(previewPortRes.statusCode, 200);

      const nextEnv = readFileSync(envFilePath, 'utf8');
      assert.match(nextEnv, /API_SERVER_PORT=3203/);
      assert.match(nextEnv, /PREVIEW_GATEWAY_PORT=4200/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('REDIS_URL and MEMORY_STORE are editable with restart required', () => {
    const redisUrl = ENV_VARS.find((v) => v.name === 'REDIS_URL');
    const memStore = ENV_VARS.find((v) => v.name === 'MEMORY_STORE');
    assert.ok(redisUrl, 'REDIS_URL should be in registry');
    assert.ok(memStore, 'MEMORY_STORE should be in registry');
    assert.equal(redisUrl.runtimeEditable, true);
    assert.equal(redisUrl.restartRequired, true);
    assert.equal(memStore.runtimeEditable, true);
    assert.equal(memStore.restartRequired, true);
  });

  it('no HINDSIGHT_* vars remain after D-1 cleanup', () => {
    const hindsightVars = ENV_VARS.filter((v) => v.name.startsWith('HINDSIGHT_'));
    assert.equal(hindsightVars.length, 0, 'All HINDSIGHT_* vars should be removed');
  });

  it('marks GITHUB_MCP_PAT, F102_API_KEY as sensitive + runtimeEditable', () => {
    for (const name of ['GITHUB_MCP_PAT', 'F102_API_KEY']) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.sensitive, true, `${name} should be sensitive`);
      assert.equal(def.runtimeEditable, true, `${name} should be runtimeEditable`);
      assert.ok(isSensitiveEditableEnvVar(def), `${name} should pass isSensitiveEditableEnvVar`);
    }
  });

  it('hasSensitiveEditableVars detects whitelisted sensitive vars', () => {
    assert.ok(hasSensitiveEditableVars(['GITHUB_MCP_PAT']));
    assert.ok(hasSensitiveEditableVars(['FRONTEND_URL', 'F102_API_KEY']));
    assert.ok(!hasSensitiveEditableVars(['FRONTEND_URL', 'CORS_ALLOW_PRIVATE_NETWORK']));
  });

  it('DEFAULT_OWNER_USER_ID is editable with restart required (trust anchor)', () => {
    const def = ENV_VARS.find((v) => v.name === 'DEFAULT_OWNER_USER_ID');
    assert.ok(def, 'DEFAULT_OWNER_USER_ID should be in registry');
    assert.equal(def.runtimeEditable, true, 'trust anchor must be editable from System Settings');
    assert.equal(def.restartRequired, true, 'trust anchor takes effect after restart');
  });

  it('locks startup-only telemetry vars as non-editable and hot-reloadable ones as editable (F153 Phase K)', () => {
    const STARTUP_ONLY = [
      'OTEL_SDK_DISABLED',
      'TELEMETRY_HMAC_SALT',
      'PROMETHEUS_PORT',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'TELEMETRY_EXPORT_RAW_SYSTEM_IDS',
      // BurnRateMonitor caches thresholds at construction — env change
      // without restart has no effect (cloud review P1, PR #2594).
      'TELEMETRY_ALERT_ERROR_RATE',
      'TELEMETRY_ALERT_P95_LATENCY_S',
      'TELEMETRY_ALERT_ACTIVE_INVOCATIONS',
    ];
    const HOT_RELOADABLE = ['PROMPT_CAPTURE', 'PROMPT_CAPTURE_CATS'];
    for (const name of STARTUP_ONLY) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.ok(!def.runtimeEditable, `${name} is startup-only — must not be editable from Hub`);
      assert.equal(isEditableEnvVar(def), false, `${name} must be rejected by isEditableEnvVar`);
    }
    for (const name of HOT_RELOADABLE) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} is hot-reloadable — must be editable from Hub`);
      assert.equal(isEditableEnvVar(def), true, `${name} must pass isEditableEnvVar`);
    }
  });
});

describe('maskUrlCredentials', () => {
  it('masks user:password in redis URL', () => {
    const result = maskUrlCredentials('redis://user:super-secret@localhost:6399/15');
    assert.ok(!result.includes('super-secret'), `Leaked password: ${result}`);
    assert.ok(result.includes('localhost:6399'), `Lost host: ${result}`);
    assert.ok(result.includes('/15'), `Lost db: ${result}`);
  });

  it('preserves URL without credentials', () => {
    const result = maskUrlCredentials('redis://localhost:6399');
    assert.ok(result.includes('localhost:6399'), `Lost host: ${result}`);
    assert.ok(!result.includes('***'), `Unnecessary masking: ${result}`);
  });

  it('masks user-only auth', () => {
    const result = maskUrlCredentials('redis://admin@localhost:6399');
    assert.ok(!result.includes('admin'), `Leaked username: ${result}`);
    assert.ok(result.includes('***'), `Should have masked: ${result}`);
  });

  it('returns *** for non-URL strings', () => {
    assert.equal(maskUrlCredentials('not-a-url'), '***');
  });
});

describe('buildEnvSummary', () => {
  afterEach(() => restoreEnv());

  it('returns currentValue for set env vars', () => {
    setEnv('API_SERVER_PORT', '4000');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'API_SERVER_PORT');
    assert.ok(entry);
    assert.equal(entry.currentValue, '4000');
  });

  it('returns null for unset env vars', () => {
    setEnv('FRONTEND_URL', undefined);
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'FRONTEND_URL');
    assert.ok(entry);
    assert.equal(entry.currentValue, null);
  });

  it('masks sensitive env vars with ***', () => {
    setEnv('GITHUB_WEBHOOK_SECRET', 'whsec-secret-12345');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'GITHUB_WEBHOOK_SECRET');
    assert.ok(entry);
    assert.equal(entry.currentValue, '***');
  });

  it('masks REDIS_URL credentials but preserves host', () => {
    setEnv('REDIS_URL', 'redis://user:super-secret@myhost:6399/15');
    const summary = buildEnvSummary();
    const entry = summary.find((v) => v.name === 'REDIS_URL');
    assert.ok(entry);
    assert.ok(!entry.currentValue.includes('super-secret'), `Leaked password: ${entry.currentValue}`);
    assert.ok(entry.currentValue.includes('myhost:6399'), `Lost host: ${entry.currentValue}`);
  });

  it('returns same number of entries as ENV_VARS', () => {
    const summary = buildEnvSummary();
    assert.ok(summary.length < ENV_VARS.length);
  });

  it('hides per-cat runtime budget env vars from hub summary', () => {
    const summary = buildEnvSummary();
    assert.equal(
      summary.some((v) => v.name === 'CAT_OPUS_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'CAT_CODEX_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'CAT_GEMINI_MAX_PROMPT_CHARS'),
      false,
    );
    assert.equal(
      summary.some((v) => v.name === 'MAX_PROMPT_TOKENS'),
      false,
    );
  });
});

describe('GET /api/config/env-summary (route)', () => {
  it('projectRoot follows CAT_TEMPLATE_PATH directory when set', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-summary-'));
    const templatePath = resolve(tempRoot, 'cat-template.json');
    writeFileSync(templatePath, '{}', 'utf8');
    setEnv('CAT_TEMPLATE_PATH', templatePath);
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      const root = body.paths.projectRoot;
      assert.equal(root, tempRoot);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('dataDirs returns absolute resolved paths from API', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const app = Fastify({ logger: false });
    await configRoutes(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
    const body = JSON.parse(res.payload);
    const { dataDirs } = body.paths;

    assert.ok(dataDirs, 'paths.dataDirs should exist');
    for (const key of ['auditLogs', 'cliArchive', 'redisDevSandbox', 'uploads']) {
      assert.ok(dataDirs[key], `dataDirs.${key} should exist`);
      assert.ok(dataDirs[key].startsWith('/'), `dataDirs.${key} should be absolute, got: ${dataDirs[key]}`);
    }

    await app.close();
  });

  // F212 Phase F (cloud codex R3 P2 on 3083d7c5f + R4 P2-#2 on fc69597675):
  // env-summary.runtimeLogs MUST equal logger's CAPTURED LOG_DIR_PATH — not
  // process.env.LOG_DIR read at request time. Runtime `PATCH /api/config/env` LOG_DIR
  // edit would change process.env but pino destination is already bound to the
  // captured path → users following the AC-F5 hint would grep an empty new directory.
  it('AC-F5 (R3+R4): runtimeLogs equals logger captured LOG_DIR_PATH (single source of truth)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const { LOG_DIR_PATH } = await import('../dist/infrastructure/logger.js');
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      const body = JSON.parse(res.payload);
      assert.equal(
        body.paths.dataDirs.runtimeLogs,
        LOG_DIR_PATH,
        'runtimeLogs MUST equal logger LOG_DIR_PATH (R3+R4 single-source fix)',
      );
      assert.ok(body.paths.dataDirs.runtimeLogs.startsWith('/'), 'absolute path');
    } finally {
      await app.close();
    }
  });

  it('AC-F5 (R4 P2-#2): runtime process.env.LOG_DIR mutation MUST NOT change reported runtimeLogs', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const { LOG_DIR_PATH } = await import('../dist/infrastructure/logger.js');
    // Mutate AFTER logger already captured (simulates runtime PATCH /api/config/env).
    const mutatedPath = mkdtempSync(resolve(tmpdir(), 'cat-cafe-mutated-log-'));
    setEnv('LOG_DIR', mutatedPath);
    const app = Fastify({ logger: false });
    try {
      await configRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      const body = JSON.parse(res.payload);
      assert.equal(
        body.paths.dataDirs.runtimeLogs,
        LOG_DIR_PATH,
        'env-summary ignores runtime mutation — stays on captured logger path',
      );
      assert.notEqual(
        body.paths.dataDirs.runtimeLogs,
        mutatedPath,
        'mutated env value MUST NOT propagate (R4 P2-#2 regression guard)',
      );
    } finally {
      await app.close();
      rmSync(mutatedPath, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/config/env (route)', () => {
  afterEach(() => restoreEnv());

  it('writes runtime-editable env vars back to the configured .env file', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const auditEvents = [];
    writeFileSync(envFilePath, 'FRONTEND_URL=http://localhost:3004\nOPENAI_API_KEY=sk-old\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: {
          append: async (event) => {
            auditEvents.push(event);
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'FRONTEND_URL', value: 'http://localhost:3200' }],
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'FRONTEND_URL=http://localhost:3200\nOPENAI_API_KEY=sk-old\n');
      assert.equal(process.env.FRONTEND_URL, 'http://localhost:3200');
      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].data.target, '.env');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('escapes shell substitution characters when persisting .env values', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const literal = 'https://proxy.example/$HOME/$(whoami)/`whoami`';
    writeFileSync(envFilePath, '', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'FRONTEND_URL', value: literal }],
        },
      });

      assert.equal(res.statusCode, 200);
      const persisted = readFileSync(envFilePath, 'utf8');
      assert.match(persisted, /^FRONTEND_URL="https:\/\/proxy\.example\/\\\$HOME\/\\\$\(whoami\)\/\\`whoami\\`"$/m);

      const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFilePath}"; printf '%s' "$FRONTEND_URL"`], {
        encoding: 'utf8',
      }).trim();
      assert.equal(sourced, literal);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('escapes CR/LF characters to avoid multiline env injection', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    const literal = 'line1\r\nline2\nline3';
    writeFileSync(envFilePath, '', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'FRONTEND_URL', value: literal }],
        },
      });

      assert.equal(res.statusCode, 200);
      const persisted = readFileSync(envFilePath, 'utf8');
      assert.match(persisted, /^FRONTEND_URL="line1\\\\r\\\\nline2\\\\nline3"$/m);
      assert.equal(persisted.trimEnd().split('\n').length, 1);

      const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFilePath}"; printf '%s' "$FRONTEND_URL"`], {
        encoding: 'utf8',
      }).trim();
      assert.equal(sourced, 'line1\\r\\nline2\\nline3');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects OPENAI_API_KEY env write since it is no longer runtimeEditable (#340 P6)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-old\n', 'utf8');
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'OPENAI_API_KEY', value: 'sk-new' }],
        },
      });

      // #340 P6: OPENAI_API_KEY is no longer runtimeEditable (managed by accounts system)
      assert.equal(res.statusCode, 400);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'OPENAI_API_KEY=sk-old\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects CONNECTOR_GATEWAY_AUTOSTART hub writes because IM autostart is a startup trust boundary', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CONNECTOR_GATEWAY_AUTOSTART=0\n', 'utf8');
    setEnv('CONNECTOR_GATEWAY_AUTOSTART', '0');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'CONNECTOR_GATEWAY_AUTOSTART', value: '1' }],
        },
      });

      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /not editable/i);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'CONNECTOR_GATEWAY_AUTOSTART=0\n');
      assert.equal(process.env.CONNECTOR_GATEWAY_AUTOSTART, '0');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects client-bundled NEXT_PUBLIC vars from hub writes because the browser reads them at build time', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(
      envFilePath,
      [
        'NEXT_PUBLIC_API_URL=http://localhost:3004',
        'NEXT_PUBLIC_WHISPER_URL=http://localhost:9876',
        'NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://localhost:9878',
        'NEXT_PUBLIC_PROJECT_ROOT=/tmp/project',
        'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI=0',
      ].join('\n') + '\n',
      'utf8',
    );

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const beforeRaw = readFileSync(envFilePath, 'utf8');
      for (const name of BOOTSTRAP_ONLY_NEXT_PUBLIC_VARS) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: {
            updates: [{ name, value: `${name}-changed` }],
          },
        });

        assert.equal(res.statusCode, 400, `${name} should be rejected`);
        const body = JSON.parse(res.payload);
        assert.match(body.error, /not editable/);
        assert.equal(readFileSync(envFilePath, 'utf8'), beforeRaw);
      }
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects internal runtime budget env vars from hub writes', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CAT_OPUS_MAX_PROMPT_CHARS=150000\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'CAT_OPUS_MAX_PROMPT_CHARS', value: '180000' }],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /not editable/);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'CAT_OPUS_MAX_PROMPT_CHARS=150000\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts API_SERVER_PORT write (editable, restart required)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'API_SERVER_PORT=3003\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: { updates: [{ name: 'API_SERVER_PORT', value: '3203' }] },
      });
      assert.equal(res.statusCode, 200, 'API_SERVER_PORT should be accepted');
      const envContent = readFileSync(envFilePath, 'utf8');
      assert.ok(envContent.includes('API_SERVER_PORT=3203'), '.env should contain the updated port');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts REDIS_URL write (editable, restart required)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'REDIS_URL=redis://localhost:6399/15\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'REDIS_URL', value: 'redis://localhost:6398/15' }],
        },
      });

      assert.equal(res.statusCode, 200, 'REDIS_URL should be accepted');
      const envContent = readFileSync(envFilePath, 'utf8');
      assert.ok(envContent.includes('REDIS_URL=redis://localhost:6398/15'), '.env should contain the updated URL');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects startup-only telemetry vars from hub writes (F153 Phase K regression)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'OTEL_SDK_DISABLED=false\nPROMETHEUS_PORT=9464\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Startup-only telemetry var must be rejected
      const otelRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'OTEL_SDK_DISABLED', value: 'true' }],
        },
      });
      assert.equal(otelRes.statusCode, 400, 'OTEL_SDK_DISABLED should be rejected');
      assert.match(JSON.parse(otelRes.payload).error, /not editable/i);

      // BurnRateMonitor caches thresholds at construction — must also be rejected
      const alertRes = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'TELEMETRY_ALERT_ERROR_RATE', value: '0.5' }],
        },
      });
      assert.equal(alertRes.statusCode, 400, 'TELEMETRY_ALERT_ERROR_RATE should be rejected (startup-only)');

      // Verify .env file unchanged for startup-only var
      const envContent = readFileSync(envFilePath, 'utf8');
      assert.match(envContent, /OTEL_SDK_DISABLED=false/, 'startup-only var must not be written');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-sensitive env vars unless runtimeEditable is explicitly true (#770)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'LOG_LEVEL=info\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'codex' },
        payload: {
          updates: [{ name: 'LOG_LEVEL', value: 'debug' }],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.match(body.error, /not editable/i);
      assert.equal(readFileSync(envFilePath, 'utf8'), 'LOG_LEVEL=info\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── #770: System settings surface allowlist ──────────────────────────

const EXPECTED_SYSTEM_VARS = [
  'API_SERVER_PORT',
  'API_SERVER_HOST',
  'BACKLOG_TTL_SECONDS',
  'CAT_CAFE_DATA_DIR',
  // #1172 Hub-visibility contract: quota credential bootstrap paths must keep
  // a real UI surface. With the Settings page filtered to surface=system,
  // System is that surface (they are platform-level bootstrap config).
  'CLAUDE_CREDENTIALS_PATH',
  'CLI_TIMEOUT_MS',
  'CODEX_CREDENTIALS_PATH',
  'CORS_ALLOW_PRIVATE_NETWORK',
  'DEFAULT_OWNER_USER_ID',
  'DRAFT_TTL_SECONDS',
  'FRONTEND_PORT',
  'FRONTEND_URL',
  'MEMORY_STORE',
  'MESSAGE_TTL_SECONDS',
  'PREVIEW_GATEWAY_ENABLED',
  'PREVIEW_GATEWAY_PORT',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
  'QUOTA_OFFICIAL_REFRESH_ENABLED',
  'REDIS_KEY_PREFIX',
  'REDIS_URL',
  'SUMMARY_TTL_SECONDS',
  'TASK_TTL_SECONDS',
  'THREAD_TTL_SECONDS',
  'TRANSCRIPT_DATA_DIR',
  'UPLOAD_DIR',
].sort();

describe('#770 system settings surface', () => {
  it('SYSTEM_VARS contains exactly the expected 27 vars', () => {
    const actual = [...SYSTEM_VARS].sort();
    assert.deepEqual(
      actual,
      EXPECTED_SYSTEM_VARS,
      `Allowlist mismatch.\nActual: ${actual}\nExpected: ${EXPECTED_SYSTEM_VARS}`,
    );
  });

  it('no connector-category var is in the system allowlist', () => {
    const connectorSystem = ENV_VARS.filter((d) => d.category === 'connector' && SYSTEM_VARS.has(d.name));
    assert.equal(
      connectorSystem.length,
      0,
      `Connector vars should not be in system allowlist: ${connectorSystem.map((d) => d.name)}`,
    );
  });

  it('every system var is runtimeEditable', () => {
    const missing = ENV_VARS.filter((d) => SYSTEM_VARS.has(d.name) && d.runtimeEditable !== true);
    assert.equal(missing.length, 0, `System vars without runtimeEditable: true: ${missing.map((d) => d.name)}`);
  });

  it('buildSystemEnvSummary returns only system vars', () => {
    const summary = buildSystemEnvSummary();
    const nonSystem = summary.filter((v) => !SYSTEM_VARS.has(v.name));
    assert.equal(nonSystem.length, 0, `Non-system vars in system summary: ${nonSystem.map((v) => v.name)}`);
    assert.equal(summary.length, EXPECTED_SYSTEM_VARS.length);
    const names = summary.map((v) => v.name).sort();
    assert.deepEqual(names, EXPECTED_SYSTEM_VARS);
  });

  it('quota credential vars are editable with restart on the System surface (#1172 UI-path)', () => {
    const summary = buildSystemEnvSummary();
    for (const name of ['QUOTA_OFFICIAL_REFRESH_ENABLED', 'CLAUDE_CREDENTIALS_PATH', 'CODEX_CREDENTIALS_PATH']) {
      const entry = summary.find((v) => v.name === name);
      assert.ok(entry, `${name} must be rendered on the System settings page`);
      assert.equal(entry.runtimeEditable, true, `${name} must be editable from System Settings`);
      assert.equal(entry.restartRequired, true, `${name} takes effect after restart`);
    }
  });

  it('startup-captured editable vars have restartRequired metadata', () => {
    const RESTART_REQUIRED = [
      'FRONTEND_URL',
      'MESSAGE_TTL_SECONDS',
      'THREAD_TTL_SECONDS',
      'TASK_TTL_SECONDS',
      'SUMMARY_TTL_SECONDS',
      'BACKLOG_TTL_SECONDS',
      'DRAFT_TTL_SECONDS',
      'PREVIEW_GATEWAY_PORT',
    ];
    for (const name of RESTART_REQUIRED) {
      const def = ENV_VARS.find((d) => d.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} should be editable (writes .env for next restart)`);
      assert.equal(def.restartRequired, true, `${name} is startup-captured — must have restartRequired: true`);
    }
  });

  it('CLI_TIMEOUT_MS is hot-editable on System surface (P1 regression guard)', () => {
    const def = ENV_VARS.find((d) => d.name === 'CLI_TIMEOUT_MS');
    assert.ok(def, 'CLI_TIMEOUT_MS should be in registry');
    assert.ok(SYSTEM_VARS.has('CLI_TIMEOUT_MS'), 'CLI_TIMEOUT_MS must be in SYSTEM_VARS');
    assert.equal(def.runtimeEditable, true, 'CLI_TIMEOUT_MS is read per-invocation — must be hot-editable');
    assert.equal(isEditableEnvVar(def), true, 'CLI_TIMEOUT_MS must pass isEditableEnvVar');
    assert.ok(def.label, 'CLI_TIMEOUT_MS must have a label for System Settings UI');
    assert.equal(def.settingsGroup, 'runtime', 'CLI_TIMEOUT_MS must be in runtime group (not lifecycle)');
    // max sourced from cli-timeout.ts — single truth for all entry points
    assert.deepEqual(
      def.numericConstraint,
      { min: 0, max: MAX_CLI_TIMEOUT_MS },
      'CLI_TIMEOUT_MS constraint uses shared MAX_CLI_TIMEOUT_MS',
    );
  });

  it('buildSystemEnvSummary is a strict subset of buildEnvSummary', () => {
    const full = new Set(buildEnvSummary().map((v) => v.name));
    const system = buildSystemEnvSummary().map((v) => v.name);
    for (const name of system) {
      assert.ok(full.has(name), `System var ${name} missing from full summary`);
    }
  });
});

describe('validateEnvValue', () => {
  it('accepts valid decimal integers for constrained vars', () => {
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', '0'), null);
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', '30000'), null);
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', '1800000'), null);
    assert.equal(validateEnvValue('PREVIEW_GATEWAY_PORT', '4100'), null);
    assert.equal(validateEnvValue('PREVIEW_GATEWAY_PORT', '1'), null);
    assert.equal(validateEnvValue('PREVIEW_GATEWAY_PORT', '65535'), null);
  });

  it('rejects non-decimal values — strict integer parsing (sol R4 P2)', () => {
    // These pass Number() but diverge from parseInt(v, 10) used by runtime
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', '0x1004'), 'hex rejected');
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', '1e3'), 'scientific notation rejected');
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', '4100.5'), 'float rejected');
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', 'abc'), 'alphabetic rejected');
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', 'NaN'), 'NaN rejected');
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', 'not-a-port'), 'text rejected');
  });

  it('rejects out-of-range values', () => {
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', '-1'), 'CLI timeout cannot be negative');
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', '0'), 'port cannot be 0');
    assert.ok(validateEnvValue('PREVIEW_GATEWAY_PORT', '70000'), 'port cannot exceed 65535');
  });

  it('rejects non-safe integers — Infinity / precision loss (sol R5 P2)', () => {
    // 400-digit number: regex passes but Number() → Infinity
    const huge = '1' + '0'.repeat(399);
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', huge), 'huge number rejected');
    assert.ok(validateEnvValue('MESSAGE_TTL_SECONDS', huge), 'huge TTL rejected');
  });

  it('CLI_TIMEOUT_MS respects shared Node timer boundary (sol R5 P2, sol R6 P2)', () => {
    // All entry points share MAX_CLI_TIMEOUT_MS from cli-timeout.ts
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', String(MAX_CLI_TIMEOUT_MS)), null, 'max safe value accepted');
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', String(MAX_CLI_TIMEOUT_MS + 1)), 'timer overflow value rejected');
    assert.ok(validateEnvValue('CLI_TIMEOUT_MS', '2000000000'), '~23 days rejected');
  });

  it('TTL vars accept negative values (0 or negative = never expire)', () => {
    assert.equal(validateEnvValue('MESSAGE_TTL_SECONDS', '-1'), null, 'negative TTL = never expire');
    assert.equal(validateEnvValue('MESSAGE_TTL_SECONDS', '0'), null, 'zero TTL = never expire');
    assert.equal(validateEnvValue('MESSAGE_TTL_SECONDS', '604800'), null, 'positive TTL = 7 days');
    assert.ok(validateEnvValue('MESSAGE_TTL_SECONDS', 'abc'), 'non-numeric TTL rejected');
  });

  it('allows empty string (unset) for constrained vars', () => {
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', ''), null);
    assert.equal(validateEnvValue('CLI_TIMEOUT_MS', '  '), null);
  });

  it('returns null for vars without constraint', () => {
    assert.equal(validateEnvValue('FRONTEND_URL', 'anything'), null);
  });
});

describe('#770 fail-closed write guard (end-to-end)', () => {
  afterEach(() => restoreEnv());

  it('rejects non-editable vars from hub writes', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CONNECTOR_GATEWAY_AUTOSTART=never\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Use vars that are NOT in SYSTEM_VARS and remain non-editable (runtimeEditable omitted)
      for (const name of ['CONNECTOR_GATEWAY_AUTOSTART', 'REDIS_PORT']) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name, value: 'new-value' }] },
        });
        assert.equal(res.statusCode, 400, `${name} should be rejected`);
        assert.match(JSON.parse(res.payload).error, /not editable/i, `${name} error message`);
      }

      assert.equal(readFileSync(envFilePath, 'utf8'), 'CONNECTOR_GATEWAY_AUTOSTART=never\n');
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid numeric values for constrained vars (sol R3 P2)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-env-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'CLI_TIMEOUT_MS=60000\n', 'utf8');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, {
        projectRoot: tempRoot,
        envFilePath,
        auditLog: { append: async () => {} },
      });
      await app.ready();

      // Non-numeric value should be rejected
      const r1 = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'test' },
        payload: { updates: [{ name: 'CLI_TIMEOUT_MS', value: 'abc' }] },
      });
      assert.equal(r1.statusCode, 400, 'non-numeric CLI_TIMEOUT_MS should be rejected');
      assert.match(JSON.parse(r1.payload).error, /decimal integer/i);

      // Negative value should be rejected
      const r2 = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'test' },
        payload: { updates: [{ name: 'CLI_TIMEOUT_MS', value: '-1' }] },
      });
      assert.equal(r2.statusCode, 400, 'negative CLI_TIMEOUT_MS should be rejected');

      // Valid numeric value should be accepted
      const r3 = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'test' },
        payload: { updates: [{ name: 'CLI_TIMEOUT_MS', value: '0' }] },
      });
      assert.equal(r3.statusCode, 200, 'CLI_TIMEOUT_MS=0 (disable) should be accepted');

      // .env should reflect last valid write
      assert.ok(readFileSync(envFilePath, 'utf8').includes('CLI_TIMEOUT_MS=0'));
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('filesystem boundary vars are editable but require restart (security boundary)', () => {
    for (const name of ['PROJECT_ALLOWED_ROOTS', 'PROJECT_ALLOWED_ROOTS_APPEND', 'PROJECT_DENIED_ROOTS']) {
      const def = ENV_VARS.find((d) => d.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} must be editable from System Settings (saves to .env)`);
      assert.equal(def.restartRequired, true, `${name} is a security boundary — must require restart`);
    }
  });

  it('startup-bound system vars are editable but require restart', () => {
    // All SYSTEM_VARS should be editable from Hub (saves to .env).
    // Startup-bound vars just need restartRequired: true to signal the user.
    for (const name of [
      'API_SERVER_HOST',
      'FRONTEND_PORT',
      'MEMORY_STORE',
      'PREVIEW_GATEWAY_ENABLED',
      'CAT_CAFE_DATA_DIR',
      'TRANSCRIPT_DATA_DIR',
      'UPLOAD_DIR',
    ]) {
      const def = ENV_VARS.find((d) => d.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} must be editable from Hub (saves to .env)`);
      assert.equal(def.restartRequired, true, `${name} is startup-bound — must have restartRequired`);
      assert.equal(isEditableEnvVar(def), true, `${name} must pass isEditableEnvVar`);
    }
  });

  it('F102 evidence toggles remain hot-editable (fail-closed regression guard)', () => {
    for (const name of ['F102_ABSTRACTIVE', 'F102_DURABLE_CANDIDATES', 'F102_TOPIC_SEGMENTS']) {
      const def = ENV_VARS.find((d) => d.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(def.runtimeEditable, true, `${name} is checked via lambda at runtime — must stay editable`);
      assert.equal(isEditableEnvVar(def), true, `${name} must pass isEditableEnvVar`);
    }
    // EMBED_MODE is startup-captured (resolvedEmbedMode in index.ts) — writable to .env
    // but takes effect only after restart. Memory page toggle must work (cloud P2 fix).
    const embed = ENV_VARS.find((d) => d.name === 'EMBED_MODE');
    assert.ok(embed, 'EMBED_MODE should be in registry');
    assert.equal(embed.runtimeEditable, true, 'EMBED_MODE must be writable to .env from Hub');
    assert.equal(embed.restartRequired, true, 'EMBED_MODE takes effect after restart');
  });

  it('Weixin runtime flags are editable, CONNECTOR_GATEWAY_AUTOSTART is not (#770)', () => {
    const WEIXIN_RUNTIME = [
      'WEIXIN_VOICE_ITEM_MODE',
      'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
      'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
    ];
    for (const name of WEIXIN_RUNTIME) {
      const def = ENV_VARS.find((d) => d.name === name);
      assert.ok(def, `${name} should be in registry`);
      assert.equal(isEditableEnvVar(def), true, `Weixin flag ${name} should be runtimeEditable`);
    }
    const autostart = ENV_VARS.find((d) => d.name === 'CONNECTOR_GATEWAY_AUTOSTART');
    assert.ok(autostart, 'CONNECTOR_GATEWAY_AUTOSTART should be in registry');
    assert.ok(!autostart.runtimeEditable, 'CONNECTOR_GATEWAY_AUTOSTART is startup-only');
  });
});

// ── #770: parseBoolEnv unified boolean parser ────────────────────────

describe('parseBoolEnv', () => {
  it('returns defaultOn when raw is undefined', () => {
    assert.equal(parseBoolEnv(undefined), false);
    assert.equal(parseBoolEnv(undefined, true), true);
  });

  it('returns defaultOn when raw is empty string', () => {
    assert.equal(parseBoolEnv(''), false);
    assert.equal(parseBoolEnv('', true), true);
  });

  it('recognizes "1" as true regardless of defaultOn', () => {
    assert.equal(parseBoolEnv('1'), true);
    assert.equal(parseBoolEnv('1', true), true);
  });

  it('recognizes "true" (case-insensitive) as true', () => {
    assert.equal(parseBoolEnv('true'), true);
    assert.equal(parseBoolEnv('TRUE'), true);
    assert.equal(parseBoolEnv('True'), true);
    assert.equal(parseBoolEnv('tRuE'), true);
  });

  it('rejects "0" as false regardless of defaultOn', () => {
    assert.equal(parseBoolEnv('0'), false);
    assert.equal(parseBoolEnv('0', true), false);
  });

  it('rejects "false" (case-insensitive) as false', () => {
    assert.equal(parseBoolEnv('false'), false);
    assert.equal(parseBoolEnv('FALSE'), false);
    assert.equal(parseBoolEnv('False'), false);
  });

  it('rejects unrecognized strings as false (fail-closed)', () => {
    assert.equal(parseBoolEnv('yes'), false);
    assert.equal(parseBoolEnv('on'), false);
    assert.equal(parseBoolEnv('enabled'), false);
    assert.equal(parseBoolEnv('random'), false);
  });

  it('unrecognized strings return false even when defaultOn=true (explicit beats default)', () => {
    assert.equal(parseBoolEnv('yes', true), false);
    assert.equal(parseBoolEnv('no', true), false);
  });

  it('boolean vars use canonical true/false defaultValues in registry', () => {
    const boolVars = ENV_VARS.filter((d) => d.booleanSemantics);
    assert.ok(boolVars.length >= 5, `Expected >= 5 boolean vars, got ${boolVars.length}`);
    for (const def of boolVars) {
      // defaultValue should not use '1' or '0' as the primary display —
      // canonical form is 'true'/'false' (with optional parenthetical).
      const stripped = def.defaultValue.replace(/（.*）/, '').trim();
      assert.ok(
        stripped === 'true' || stripped === 'false' || stripped.startsWith('('),
        `${def.name} defaultValue should use canonical true/false, got: '${def.defaultValue}'`,
      );
    }
  });
});

// ── #770: CORS private network boundary — parseBoolEnv integration ───

describe('CORS_ALLOW_PRIVATE_NETWORK parseBoolEnv integration', () => {
  afterEach(() => restoreEnv());

  it('CORS=1 opens private network origin (expanded boundary)', async () => {
    setEnv('CORS_ALLOW_PRIVATE_NETWORK', '1');
    const { resolveFrontendCorsOrigins, PRIVATE_NETWORK_ORIGIN } = await import('../dist/config/frontend-origin.js');
    const origins = resolveFrontendCorsOrigins(process.env);
    assert.ok(
      origins.some((o) => o === PRIVATE_NETWORK_ORIGIN),
      'CORS=1 must include private network origin after parseBoolEnv unification',
    );
  });

  it('CORS=true opens private network origin (canonical value)', async () => {
    setEnv('CORS_ALLOW_PRIVATE_NETWORK', 'true');
    const { resolveFrontendCorsOrigins, PRIVATE_NETWORK_ORIGIN } = await import('../dist/config/frontend-origin.js');
    const origins = resolveFrontendCorsOrigins(process.env);
    assert.ok(
      origins.some((o) => o === PRIVATE_NETWORK_ORIGIN),
      'CORS=true must include private network origin',
    );
  });

  it('CORS unset does not open private network origin', async () => {
    setEnv('CORS_ALLOW_PRIVATE_NETWORK', undefined);
    const { resolveFrontendCorsOrigins, PRIVATE_NETWORK_ORIGIN } = await import('../dist/config/frontend-origin.js');
    const origins = resolveFrontendCorsOrigins(process.env);
    assert.ok(!origins.some((o) => o === PRIVATE_NETWORK_ORIGIN), 'CORS unset must not include private network origin');
  });

  it('CORS=false does not open private network origin', async () => {
    setEnv('CORS_ALLOW_PRIVATE_NETWORK', 'false');
    const { resolveFrontendCorsOrigins, PRIVATE_NETWORK_ORIGIN } = await import('../dist/config/frontend-origin.js');
    const origins = resolveFrontendCorsOrigins(process.env);
    assert.ok(!origins.some((o) => o === PRIVATE_NETWORK_ORIGIN), 'CORS=false must not include private network origin');
  });
});
