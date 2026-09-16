/**
 * #770 P0 D1/D7 effect test: env-summary?surface=system exposes savedValue
 * (what PATCH actually persisted to .env) and shadowedByLocal (whether
 * .env.local defines the key and therefore overrides any Hub write), so the
 * UI can show "已保存 X，当前生效 Y" without a post-save refetch bouncing
 * drafts back to the stale pre-restart value.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

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

async function getSystemVar(app, name) {
  const res = await app.inject({ method: 'GET', url: '/api/config/env-summary?surface=system' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  const entry = body.variables.find((v) => v.name === name);
  assert.ok(entry, `${name} must be in the system surface`);
  return entry;
}

describe('#770 D1/D7: savedValue + .env.local shadow marker', () => {
  it('PATCH persists savedValue while currentValue stays pre-restart', async () => {
    const savedDataDir = process.env.DATA_DIR;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-saved-value-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');
    delete process.env.DATA_DIR;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'DATA_DIR', value: '/new-cat-cafe-data' }] },
        });
        assert.equal(res.statusCode, 200, `PATCH rejected: ${res.payload}`);

        const entry = await getSystemVar(app, 'DATA_DIR');
        assert.equal(entry.savedValue, '/new-cat-cafe-data', '.env now holds the new value');
        assert.notEqual(entry.currentValue, '/new-cat-cafe-data', 'runtime value must stay pre-restart');
        assert.equal(entry.shadowedByLocal, false, 'no .env.local exists in this temp root');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = savedDataDir;
    }
  });

  it('a key present in .env.local is flagged shadowedByLocal', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-saved-value-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'DATA_DIR=/from-dot-env\n', 'utf8');
    writeFileSync(resolve(tempRoot, '.env.local'), 'DATA_DIR=/from-local\n', 'utf8');
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const entry = await getSystemVar(app, 'DATA_DIR');
        assert.equal(entry.savedValue, '/from-dot-env', 'savedValue still reports the .env line');
        assert.equal(entry.shadowedByLocal, true, '.env.local defines the same key → Hub writes are overridden');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('savedValue is masked with the same policy as currentValue', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-saved-value-'));
    const envFilePath = resolve(tempRoot, '.env');
    writeFileSync(envFilePath, 'REDIS_URL=redis://:topsecret@127.0.0.1:6379/0\n', 'utf8');
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const entry = await getSystemVar(app, 'REDIS_URL');
        assert.ok(entry.savedValue, 'savedValue present for a .env-defined var');
        assert.ok(!entry.savedValue.includes('topsecret'), 'savedValue must not leak the .env password');
        assert.equal(entry.savedValue, 'redis://127.0.0.1:6379/0', 'url credentials stripped like currentValue');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
