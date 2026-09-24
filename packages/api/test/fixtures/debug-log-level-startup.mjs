/**
 * F770 red-test fixture: run with `node <this file> --debug`.
 * Asserts the REAL startup path — stored log level in user-preferences.json
 * must NOT override the --debug flag when configRoutes registers.
 * Exit 0 + DEBUG_STARTUP_OK marker on success; non-zero with a stderr
 * assertion message on regression.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tempRoot = process.env.TEST_TEMP_ROOT;
assert.ok(tempRoot, 'TEST_TEMP_ROOT env required');

const envFilePath = resolve(tempRoot, '.env');
writeFileSync(envFilePath, '', 'utf8');

// Store an explicit preference BEFORE any logger/config import.
const { updateUserPreferences } = await import('../../dist/config/user-preferences-store.js');
updateUserPreferences(tempRoot, (current) => ({ ...current, logLevel: 'info' }));

const { logger } = await import('../../dist/infrastructure/logger.js');
assert.equal(logger.level, 'debug', `import-time level with --debug must be debug, got: ${logger.level}`);

const Fastify = (await import('fastify')).default;
const { configRoutes } = await import('../../dist/routes/config.js');
const app = Fastify({ logger: false });
await configRoutes(app, {
  projectRoot: tempRoot,
  envFilePath,
  auditLog: { append: async () => {} },
});
assert.equal(
  logger.level,
  'debug',
  `registering configRoutes must not override --debug with the stored level, got: ${logger.level}`,
);

// The honest effective level for the UI: --debug in effect must report debug.
const got = await app.inject({ method: 'GET', url: '/api/config/log-level' });
assert.equal(got.json().effectiveLevel, 'debug', `effectiveLevel under --debug must be debug, got: ${got.payload}`);

await app.close();
console.log('DEBUG_STARTUP_OK');
