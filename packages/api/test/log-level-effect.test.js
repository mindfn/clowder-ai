/**
 * #770 F770 log-level storage slice: LOG_LEVEL lives in user-preferences.json
 * and applies at runtime through PUT /api/config/log-level (no restart).
 * The .env tier remains a read-only startup fallback (never migrated by a
 * GET — only an intentional PUT lands in the JSON store); PATCH
 * /api/config/env must now reject LOG_LEVEL — the double source is
 * eliminated. Startup precedence: debug intent (--debug flag or
 * CAT_CAFE_DEBUG=1) > stored preference > LOG_LEVEL env > default 'info'.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import { createModuleLogger, logger, setRuntimeLogLevel } from '../dist/infrastructure/logger.js';

async function buildApp(envFilePath, tempRoot) {
  const { configRoutes } = await import('../dist/routes/config.js');
  const app = Fastify({ logger: false });
  await configRoutes(app, {
    projectRoot: tempRoot,
    envFilePath,
    auditLog: { append: async () => {} },
  });
  await app.ready();
  return app;
}

describe('#770 F770: log level applies at runtime without restart', () => {
  it('PUT debug hot-applies to the root logger and child loggers; revert works', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/config/log-level',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { logLevel: 'debug' },
        });
        assert.equal(res.statusCode, 200, `PUT rejected: ${res.payload}`);
        assert.equal(res.json().applied, true);

        assert.equal(logger.isLevelEnabled('debug'), true, 'root pino logger must enable debug without restart');
        const child = createModuleLogger('f770-log-level-effect');
        assert.equal(child.isLevelEnabled('debug'), true, 'child loggers must follow the runtime level');

        const got = await app.inject({ method: 'GET', url: '/api/config/log-level' });
        assert.equal(got.json().logLevel, 'debug');
        assert.equal(got.json().source, 'preferences');
        assert.equal(got.json().effectiveLevel, 'debug');

        // And reverting hot-applies too.
        const back = await app.inject({
          method: 'PUT',
          url: '/api/config/log-level',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { logLevel: 'error' },
        });
        assert.equal(back.statusCode, 200);
        assert.equal(logger.isLevelEnabled('debug'), false, 'reverting the level must hot-apply as well');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      setRuntimeLogLevel(originalLevel);
    }
  });

  it('treats the env value as a read-only fallback: GET reports it without persisting it', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        process.env.LOG_LEVEL = 'warn';

        const first = await app.inject({ method: 'GET', url: '/api/config/log-level' });
        assert.equal(first.statusCode, 200);
        const firstBody = first.json();
        assert.equal(firstBody.logLevel, 'warn');
        assert.equal(firstBody.source, 'env-fallback');
        assert.equal(firstBody.migratedFromEnv, false, 'a GET must never migrate the env value');

        // Nothing may land in the JSON store from a read — the env fallback is
        // ephemeral. Opening the settings page must not change future behavior.
        const { readUserPreferences, updateUserPreferences } = await import('../dist/config/user-preferences-store.js');
        assert.equal(readUserPreferences(tempRoot).logLevel, undefined);

        // The fallback keeps working on subsequent reads while the env is set.
        const second = await app.inject({ method: 'GET', url: '/api/config/log-level' });
        assert.equal(second.json().source, 'env-fallback');
        assert.equal(second.json().logLevel, 'warn');

        // An intentional PUT is the only write path: once stored, the stored
        // value wins over the still-present env value.
        const put = await app.inject({
          method: 'PUT',
          url: '/api/config/log-level',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { logLevel: 'debug' },
        });
        assert.equal(put.statusCode, 200);
        const third = await app.inject({ method: 'GET', url: '/api/config/log-level' });
        assert.equal(third.json().source, 'preferences');
        assert.equal(third.json().logLevel, 'debug');

        // Clearing the stored value returns to the env fallback (or 'none').
        updateUserPreferences(tempRoot, (current) => {
          const next = { ...current };
          delete next.logLevel;
          return next;
        });
        const fourth = await app.inject({ method: 'GET', url: '/api/config/log-level' });
        assert.equal(fourth.json().source, 'env-fallback');
        assert.equal(fourth.json().logLevel, 'warn');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      setRuntimeLogLevel(originalLevel);
    }
  });

  it('startup applies the persisted JSON level over the import-time env fallback', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const { updateUserPreferences } = await import('../dist/config/user-preferences-store.js');
      updateUserPreferences(tempRoot, (current) => ({ ...current, logLevel: 'error' }));
      const app = await buildApp(envFilePath, tempRoot);
      try {
        assert.equal(logger.level, 'error', 'registering configRoutes must apply the persisted JSON level at startup');
        assert.equal(
          updateUserPreferences(tempRoot, (current) => current).logLevel,
          'error',
          'startup application must be read-only (no migration write at boot)',
        );
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      setRuntimeLogLevel(originalLevel);
    }
  });

  // The full precedence matrix on the REAL startup path, one child process per
  // case (isDebugMode is an import-time constant; in-process mocks cannot
  // cover it). 'argv' exercises the --debug flag path (start-windows.ps1,
  // packaged entry); 'env' exercises CAT_CAFE_DEBUG=1 with NO --debug flag —
  // that is what start-dev.sh --debug actually produces.
  const startupCases = [
    {
      name: 'argv --debug beats stored info + env warn',
      stored: 'info',
      envLevel: 'warn',
      debugStyle: 'argv',
      expect: 'debug',
    },
    {
      name: 'CAT_CAFE_DEBUG=1 (start-dev.sh --debug) beats stored info + env warn',
      stored: 'info',
      envLevel: 'warn',
      debugStyle: 'env',
      expect: 'debug',
    },
    {
      name: 'stored info beats env warn without debug intent',
      stored: 'info',
      envLevel: 'warn',
      debugStyle: 'none',
      expect: 'info',
    },
    {
      name: 'env warn is the fallback when nothing is stored (GET must not persist it)',
      stored: null,
      envLevel: 'warn',
      debugStyle: 'none',
      expect: 'warn',
    },
    {
      name: "default 'info' when nothing is set anywhere",
      stored: null,
      envLevel: null,
      debugStyle: 'none',
      expect: 'info',
    },
  ];
  for (const startupCase of startupCases) {
    it(`startup precedence: ${startupCase.name}`, async () => {
      const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
      try {
        const fixture = resolve(import.meta.dirname, 'fixtures/debug-log-level-startup.mjs');
        const setup = resolve(import.meta.dirname, 'helpers/setup-cat-registry.js');
        const childEnv = { ...process.env, TEST_TEMP_ROOT: tempRoot, NODE_ENV: 'test' };
        delete childEnv.LOG_LEVEL;
        delete childEnv.CAT_CAFE_DEBUG;
        if (startupCase.envLevel) childEnv.LOG_LEVEL = startupCase.envLevel;
        if (startupCase.stored) childEnv.TEST_STORED_LEVEL = startupCase.stored;
        childEnv.TEST_DEBUG_STYLE = startupCase.debugStyle;
        if (startupCase.debugStyle === 'env') childEnv.CAT_CAFE_DEBUG = '1';
        await new Promise((resolvePromise, rejectPromise) => {
          execFile(
            process.execPath,
            ['--import', setup, fixture, ...(startupCase.debugStyle === 'argv' ? ['--debug'] : [])],
            { env: childEnv, timeout: 60_000 },
            (error, stdout, stderr) => {
              if (error) {
                rejectPromise(new Error(`startup precedence fixture failed: ${stderr || stdout}`));
                return;
              }
              assert.match(`${stdout}\n${stderr}`, /DEBUG_STARTUP_OK/);
              resolvePromise();
            },
          );
        });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

describe('#770 F770: the env double source is eliminated', () => {
  it('PATCH /api/config/env rejects LOG_LEVEL and the system surface no longer lists it', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'LOG_LEVEL=info\nOTHER_KEY=keep\n', 'utf8');
    process.env.LOG_LEVEL = 'info';
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'LOG_LEVEL', value: 'debug' }] },
        });
        assert.equal(res.statusCode, 400, `LOG_LEVEL must no longer be env-editable: ${res.payload}`);
        assert.match(res.json().error, /not editable/);

        // The rejection must happen before ANY write: .env byte-identical.
        const { readFileSync } = await import('node:fs');
        assert.equal(
          readFileSync(envFilePath, 'utf8'),
          'LOG_LEVEL=info\nOTHER_KEY=keep\n',
          'rejected PATCH must not touch .env at all',
        );

        const summary = await app.inject({ method: 'GET', url: '/api/config/env-summary?surface=system' });
        assert.equal(summary.statusCode, 200);
        const entry = JSON.parse(summary.payload).variables.find((v) => v.name === 'LOG_LEVEL');
        assert.equal(entry, undefined, 'deprecated LOG_LEVEL must be gone from the system surface');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      setRuntimeLogLevel(originalLevel);
    }
  });

  it('PUT rejects unknown levels and wrong case without touching the runtime logger', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const levelBefore = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        for (const bogus of ['bogus', 'INFO', '']) {
          const res = await app.inject({
            method: 'PUT',
            url: '/api/config/log-level',
            headers: { 'x-cat-cafe-user': 'codex' },
            payload: { logLevel: bogus },
          });
          assert.equal(res.statusCode, 400, `level '${bogus}' must be rejected, got: ${res.payload}`);
        }
        assert.equal(logger.level, levelBefore, 'rejected PUT must not touch the runtime logger');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      setRuntimeLogLevel(originalLevel);
    }
  });

  it('rejects writes without identity and writes from a non-owner', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const savedOwner = process.env.DEFAULT_OWNER_USER_ID;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const noIdentity = await app.inject({
          method: 'PUT',
          url: '/api/config/log-level',
          payload: { logLevel: 'debug' },
        });
        assert.equal(noIdentity.statusCode, 400);

        process.env.DEFAULT_OWNER_USER_ID = 'owner-real';
        const wrongUser = await app.inject({
          method: 'PUT',
          url: '/api/config/log-level',
          headers: { 'x-cat-cafe-user': 'intruder' },
          payload: { logLevel: 'debug' },
        });
        assert.equal(wrongUser.statusCode, 403);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedEnv;
      if (savedOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = savedOwner;
      setRuntimeLogLevel(originalLevel);
    }
  });
});
