/**
 * #770 P0 D2 effect test: LOG_LEVEL changes apply at runtime (no restart).
 * Root pino level + every tracked child logger must reflect a PATCH, and the
 * system env-summary must report the EFFECTIVE level when the var is unset
 * (dropdown fallback instead of the bogus first option).
 */
import assert from 'node:assert/strict';
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

describe('#770 D2: LOG_LEVEL applies at runtime without restart', () => {
  it('PATCH debug enables debug on the root logger and on child loggers', async () => {
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
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'LOG_LEVEL', value: 'debug' }] },
        });
        assert.equal(res.statusCode, 200, `PATCH rejected: ${res.payload}`);

        assert.equal(logger.isLevelEnabled('debug'), true, 'root pino logger must enable debug without restart');
        const child = createModuleLogger('d2-effect-test');
        assert.equal(child.isLevelEnabled('debug'), true, 'child loggers must follow the runtime level');

        // And reverting hot-applies too.
        const back = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'LOG_LEVEL', value: 'error' }] },
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

  it('system env-summary reports the effective level when LOG_LEVEL is unset', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.LOG_LEVEL;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/config/env-summary?surface=system' });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.payload);
        const entry = body.variables.find((v) => v.name === 'LOG_LEVEL');
        assert.ok(entry, 'LOG_LEVEL must be in the system surface');
        assert.equal(entry.restartRequired, false, 'LOG_LEVEL is now an immediate-apply var');
        assert.equal(
          entry.currentValue,
          logger.level,
          'unset LOG_LEVEL must surface the effective level, not empty (which the UI rendered as fatal)',
        );
        assert.notEqual(entry.currentValue, 'fatal');
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
});

/**
 * #770 P0 P1 fix effect test: PATCH must validate allowedValues BEFORE writing
 * anything. A bogus LOG_LEVEL must be rejected with 400, leave .env untouched,
 * leave process.env untouched, and leave the runtime logger level unchanged —
 * otherwise the value would crash the API at next full restart (logger.ts feeds
 * the raw string to pino, which throws "default level:X must be included in
 * custom levels" and the process never comes up).
 */
describe('#770 P1: PATCH rejects values outside declared allowedValues', () => {
  it('PATCH LOG_LEVEL=bogus → 400, .env unchanged, process.env and logger level unchanged', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const levelBefore = logger.level;
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
          payload: { updates: [{ name: 'LOG_LEVEL', value: 'bogus' }] },
        });
        assert.equal(res.statusCode, 400, `bogus level must be rejected, got: ${res.payload}`);
        const body = JSON.parse(res.payload);
        assert.match(body.error, /Allowed values: .*info/, 'error must name the allowed values');

        // The rejection must happen before ANY write: .env byte-identical.
        const { readFileSync } = await import('node:fs');
        assert.equal(
          readFileSync(envFilePath, 'utf8'),
          'LOG_LEVEL=info\nOTHER_KEY=keep\n',
          'rejected PATCH must not touch .env at all',
        );
        assert.equal(process.env.LOG_LEVEL, 'info', 'rejected PATCH must not touch process.env');
        assert.equal(logger.level, levelBefore, 'rejected PATCH must not touch the runtime logger');
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

  it('PATCH LOG_LEVEL=INFO (wrong case, also unknown to pino) → 400', async () => {
    const savedEnv = process.env.LOG_LEVEL;
    const originalLevel = logger.level;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-log-level-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    process.env.LOG_LEVEL = 'info';
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'LOG_LEVEL', value: 'INFO' }] },
        });
        assert.equal(res.statusCode, 400, `whitelist is exact-membership, got: ${res.payload}`);
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
});
