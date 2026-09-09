/**
 * #770: GET /api/config/dir-list — loopback-only directory listing for the
 * browser fallback of the dirpicker settings control.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET /api/config/dir-list', () => {
  it('rejects proxied/non-loopback requests with 403', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-dir-list-'));

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, { projectRoot: tempRoot, auditLog: { append: async () => {} } });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/dir-list?path=/tmp',
        headers: { 'x-forwarded-for': '192.168.1.50', host: 'evil.example' },
      });

      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.payload).error, /trusted local API request/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects requests with a non-loopback Host header (malicious-webpage CSRF)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-dir-list-'));

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, { projectRoot: tempRoot, auditLog: { append: async () => {} } });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/dir-list?path=/tmp',
        headers: { host: 'evil.example' },
      });

      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.payload).error, /trusted local API request/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects requests with a non-local Origin header (malicious-webpage CSRF)', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-dir-list-'));

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, { projectRoot: tempRoot, auditLog: { append: async () => {} } });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/dir-list?path=/tmp',
        headers: { origin: 'https://evil.example' },
      });

      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.payload).error, /trusted local API request/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('lists only subdirectories, sorted by name, with parent path', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-dir-list-'));
    mkdirSync(resolve(tempRoot, 'zebra'));
    mkdirSync(resolve(tempRoot, 'alpha'));
    mkdirSync(resolve(tempRoot, 'nested/inner'), { recursive: true });
    writeFileSync(resolve(tempRoot, 'file.txt'), 'not a dir\n');

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, { projectRoot: tempRoot, auditLog: { append: async () => {} } });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/api/config/dir-list?path=${encodeURIComponent(tempRoot)}`,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.path, resolve(tempRoot));
      assert.equal(body.parent, resolve(tempRoot, '..'));
      assert.deepEqual(
        body.entries.map((entry) => entry.name),
        ['alpha', 'nested', 'zebra'],
      );
      assert.equal(body.entries[0].path, resolve(tempRoot, 'alpha'));
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns 404 for a missing directory and 400 for a missing path param', async () => {
    const { configRoutes } = await import('../dist/routes/config.js');
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-dir-list-'));

    const app = Fastify({ logger: false });
    try {
      await configRoutes(app, { projectRoot: tempRoot, auditLog: { append: async () => {} } });
      await app.ready();

      const missing = await app.inject({
        method: 'GET',
        url: `/api/config/dir-list?path=${encodeURIComponent(resolve(tempRoot, 'nope'))}`,
      });
      assert.equal(missing.statusCode, 404);
      assert.ok(JSON.parse(missing.payload).error);

      const noParam = await app.inject({ method: 'GET', url: '/api/config/dir-list' });
      assert.equal(noParam.statusCode, 400);
      assert.match(JSON.parse(noParam.payload).error, /"path" is required/);
    } finally {
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
