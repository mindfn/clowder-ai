/**
 * F770 fixture: run via `node --import <setup> <this file> [--debug]`.
 * Configuration comes from env so one fixture covers the whole precedence
 * matrix on the REAL startup path (isDebugMode is an import-time constant —
 * in-process mocks cannot cover it):
 *   TEST_TEMP_ROOT      (required) isolated project root
 *   TEST_STORED_LEVEL   written into user-preferences.json BEFORE any import;
 *                       unset = nothing stored
 *   LOG_LEVEL           set directly in this process env; unset = unset
 *   CAT_CAFE_DEBUG=1    set directly in this process env (style 'env')
 *   TEST_DEBUG_STYLE    'argv' | 'env' | 'none'
 *                       'argv': this process was launched with a real --debug
 *                               flag (start-windows.ps1 — the packaged desktop
 *                               build never passes --debug to the API, so this
 *                               style is source-launch only)
 *                       'env':  CAT_CAFE_DEBUG=1 is set in the environment and
 *                               argv has NO --debug (start-dev.sh --debug path)
 * Asserts, at every step:
 *   debug intent > stored user preference > LOG_LEVEL env (legacy fallback)
 *   > default 'info'
 *   - import-time logger.level matches the expected winner
 *   - registering configRoutes never changes the level
 *   - GET /api/config/log-level reports that same level as effectiveLevel
 *   - a GET never persists anything: when nothing was stored, the JSON store
 *     must remain logLevel-free afterwards (read-only env fallback)
 * Exit 0 + DEBUG_STARTUP_OK on success; non-zero with a stderr assertion
 * message on regression.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tempRoot = process.env.TEST_TEMP_ROOT;
assert.ok(tempRoot, 'TEST_TEMP_ROOT env required');
const storedLevel = process.env.TEST_STORED_LEVEL || null;
// LOG_LEVEL / CAT_CAFE_DEBUG arrive directly in this process env (the test
// builds the child env); read them BEFORE any import because logger.ts
// captures both as import-time constants.
const envLogLevel = process.env.LOG_LEVEL || null;
const debugStyle = process.env.TEST_DEBUG_STYLE || 'none';
assert.ok(['argv', 'env', 'none'].includes(debugStyle), `bad TEST_DEBUG_STYLE: ${debugStyle}`);
if (debugStyle === 'argv') {
  assert.ok(process.argv.includes('--debug'), "TEST_DEBUG_STYLE='argv' requires a real --debug in argv");
}
if (debugStyle === 'env') {
  assert.ok(
    process.env.CAT_CAFE_DEBUG === '1' || process.env.CAT_CAFE_DEBUG === 'true',
    "TEST_DEBUG_STYLE='env' requires CAT_CAFE_DEBUG=1",
  );
  assert.ok(!process.argv.includes('--debug'), "TEST_DEBUG_STYLE='env' must NOT have --debug in argv");
}

const envFilePath = resolve(tempRoot, '.env');
writeFileSync(envFilePath, '', 'utf8');

// Seed the store BEFORE any logger/config import, exactly like a user who
// once picked a level in the UI.
if (storedLevel) {
  const { updateUserPreferences } = await import('../../dist/config/user-preferences-store.js');
  updateUserPreferences(tempRoot, (current) => ({ ...current, logLevel: storedLevel }));
}

const hasDebugIntent =
  process.argv.includes('--debug') || process.env.CAT_CAFE_DEBUG === '1' || process.env.CAT_CAFE_DEBUG === 'true';
// logger.ts resolves its import-time level from the debug intent / env only;
// a stored preference is applied LATER, at configRoutes registration.
const importTimeExpected = hasDebugIntent ? 'debug' : (envLogLevel ?? 'info');
const afterRegistrationExpected = hasDebugIntent ? 'debug' : (storedLevel ?? envLogLevel ?? 'info');

const { logger } = await import('../../dist/infrastructure/logger.js');
assert.equal(
  logger.level,
  importTimeExpected,
  `import-time level must be '${importTimeExpected}', got: ${logger.level}`,
);

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
  afterRegistrationExpected,
  `registering configRoutes must leave the level at '${afterRegistrationExpected}', got: ${logger.level}`,
);

// The honest effective level for the UI: whatever is in effect must be
// reported, never the stored value when the debug intent outranks it.
const got = await app.inject({ method: 'GET', url: '/api/config/log-level' });
assert.equal(
  got.json().effectiveLevel,
  afterRegistrationExpected,
  `effectiveLevel must be '${afterRegistrationExpected}', got: ${got.payload}`,
);

// Reading must never write: with nothing stored, the env fallback stays
// ephemeral — a GET must not land it in the JSON store.
if (!storedLevel) {
  const { readUserPreferences } = await import('../../dist/config/user-preferences-store.js');
  assert.equal(
    readUserPreferences(tempRoot).logLevel,
    undefined,
    'GET must not persist the env fallback into the JSON store (read-only fallback)',
  );
}

await app.close();
// NB: console.log is redirected through the pino level gate, so the marker
// must go to stderr directly to survive every level this fixture runs at.
process.stderr.write('DEBUG_STARTUP_OK\n');
