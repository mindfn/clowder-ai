// @ts-check

/**
 * #1050 — MCP drift resolve accepts undefined projectPath (global scope).
 *
 * The "Sync All" button in the MCP management page calls resolveScope('sync', undefined)
 * for the global scope. The backend must fall back to STARTUP_REPO_ROOT instead of
 * returning 400 "Required: projectPath for MCP resolve".
 *
 * This test verifies the route-level behavior: sending MCP resolve without projectPath
 * should NOT return the old "Required: projectPath" error.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { unifiedDriftRoutes } = await import('../dist/routes/drift.js');

/** Auth headers that pass requireDriftWriteAccess. */
const AUTH_HEADERS = {
  'x-test-session-user': 'you',
  host: 'localhost:3004',
  origin: 'http://localhost:3003',
};

describe('#1050 — MCP drift resolve without projectPath', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(unifiedDriftRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('does not reject MCP resolve when projectPath is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync' },
    });
    // The old behavior returned 400 with "Required: projectPath for MCP resolve".
    // After fix: should NOT return that error — it may fail deeper (e.g. no drift),
    // but not at the projectPath-required gate.
    assert.notEqual(res.json().error, 'Required: projectPath for MCP resolve');
  });

  it('does not reject MCP resolve when projectPath is explicitly undefined', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync', projectPath: undefined },
    });
    assert.notEqual(res.json().error, 'Required: projectPath for MCP resolve');
  });

  it('still rejects MCP resolve with invalid projectPath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: {
        type: 'mcp',
        action: 'sync',
        projectPath: '/nonexistent/path/that/should/fail/validation',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Invalid project path');
  });
});
