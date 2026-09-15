/**
 * #770 P0 D3 effect test: toggle write-back values must be honored by the
 * actual readers. The System settings toggle serializes per booleanSemantics
 * (exactTrue → 'true'/'false', exactOne/notZero → '1'/'0'); these tests pin
 * the reader side of that contract so a blanket '1'/'0' writer can never
 * regress silently again.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PRIVATE_NETWORK_ORIGIN, resolveFrontendCorsOrigins } from '../dist/config/frontend-origin.js';
import { getAllowedRoots, isDenylistMode } from '../dist/utils/project-path.js';

const SAVED = /** @type {Record<string, string | undefined>} */ ({});

function setEnv(name, value) {
  if (!(name in SAVED)) SAVED[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  for (const key of Object.keys(SAVED)) delete SAVED[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('#770 D3: CORS_ALLOW_PRIVATE_NETWORK toggle value is honored by frontend-origin', () => {
  it("'true' (exactTrue serialization) admits the private-network origin", () => {
    // Value the page toggle now writes for the ON position.
    const origins = resolveFrontendCorsOrigins({ CORS_ALLOW_PRIVATE_NETWORK: 'true' });
    assert.ok(
      origins.includes(PRIVATE_NETWORK_ORIGIN),
      'reader must honor the toggle-written value; blanket 1/0 writer regressed',
    );
  });

  it("'false' keeps the private-network origin out", () => {
    const origins = resolveFrontendCorsOrigins({ CORS_ALLOW_PRIVATE_NETWORK: 'false' });
    assert.ok(!origins.includes(PRIVATE_NETWORK_ORIGIN));
  });
});

describe('#770 D3: PROJECT_ALLOWED_ROOTS_APPEND toggle value is honored by project-path', () => {
  it("'true' merges custom roots with legacy defaults instead of replacing them", () => {
    setEnv('PROJECT_ALLOWED_ROOTS', '/tmp/cat-cafe-custom-root');
    setEnv('PROJECT_ALLOWED_ROOTS_APPEND', 'true');

    const roots = getAllowedRoots();
    assert.ok(roots.includes('/tmp/cat-cafe-custom-root'), 'custom root must survive');
    const defaults = roots.filter((root) => root !== '/tmp/cat-cafe-custom-root');
    assert.ok(defaults.length > 0, "'true' must MERGE legacy defaults, not replace them");
  });

  it("'false' uses allowlist mode with custom roots only", () => {
    setEnv('PROJECT_ALLOWED_ROOTS', '/tmp/cat-cafe-custom-root');
    setEnv('PROJECT_ALLOWED_ROOTS_APPEND', 'false');

    const roots = getAllowedRoots();
    assert.deepEqual(roots, ['/tmp/cat-cafe-custom-root']);
    assert.equal(isDenylistMode(), false);
  });
});
