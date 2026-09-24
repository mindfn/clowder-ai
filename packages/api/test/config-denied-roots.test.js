/**
 * #770 F770 denied-roots storage slice: PROJECT_DENIED_ROOTS custom entries live
 * in user-preferences.json (deniedRoots) and apply at runtime through
 * PUT /api/config/denied-roots (no restart). Platform default denied roots are
 * ALWAYS enforced on top — the custom list can only add, never remove.
 *
 * Semantics that differ from the theme/log-level slices (deliberate):
 *   - an EMPTY ARRAY is a stored state: it clears every custom denial and must
 *     override the env fallback — otherwise clearing the blacklist would
 *     silently revive the env value (security-control resurrection).
 *   - FAIL-CLOSED: when the JSON provider is unwired / absent / broken,
 *     validation degrades toward platform defaults (+ legacy env), never
 *     toward "no restriction".
 *   - STORED ROOTS ARE CANONICAL: validateProjectPathDetailed realpaths the
 *     candidate before comparison, and macOS aliases /tmp, /var, /etc behind
 *     /private/... symlinks — a literal '/tmp/x' would never match the
 *     candidate's '/private/tmp/x' (silent security-control failure). Roots
 *     are canonicalized at save time (longest-existing-ancestor realpath, so
 *     not-yet-created directories still canonicalize), and GET returns the
 *     canonical values so the UI states exactly what is being blocked.
 * The .env tier remains a strictly read-only fallback (NO read-time migration —
 * same contract as log level and data retention): only an intentional PUT
 * persists, and at wiring the env fallback is canonicalized once into an
 * in-memory snapshot so env-only '/tmp/...' entries still match realpath'd
 * candidates without any per-validation disk IO.
 * PATCH /api/config/env must reject PROJECT_DENIED_ROOTS.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import {
  canonicalizeDeniedRoot,
  isUnderAllowedRoot,
  setDeniedRootsProvider,
  validateProjectPathDetailed,
} from '../dist/utils/project-path.js';

const { getRuntimeDeniedRoots, resetDeniedRootsRuntimeForTests } = await import(
  '../dist/config/user-preferences-store.js'
);

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

function tempSetup() {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-denied-roots-'));
  const envFilePath = resolve(tempRoot, '.env');
  writeFileSync(envFilePath, '', 'utf8');
  return { tempRoot, envFilePath };
}

describe('#770 F770: denied roots apply at runtime without restart', () => {
  it('PUT custom roots hot-applies to path validation in the same process; clearing hot-applies too', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    const denied = resolve(tmpdir(), 'f770-denied-roots-blocked');
    const allowed = resolve(tmpdir(), 'f770-denied-roots-fine');
    mkdirSync(denied, { recursive: true });
    mkdirSync(allowed, { recursive: true });
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const probe = await validateProjectPathDetailed(denied);
        assert.equal(probe.ok, true, `control: path is allowed before PUT: ${JSON.stringify(probe)}`);

        const res = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: [denied] },
        });
        assert.equal(res.statusCode, 200, `PUT rejected: ${res.payload}`);
        assert.equal(res.json().source, 'preferences');

        const blocked = await validateProjectPathDetailed(denied);
        assert.equal(blocked.ok, false, 'custom denied root must block validation without restart');
        assert.equal(blocked.reason, 'denied_root');
        const fine = await validateProjectPathDetailed(allowed);
        assert.equal(fine.ok, true, 'unrelated paths stay allowed');

        const got = await app.inject({ method: 'GET', url: '/api/config/denied-roots' });
        assert.deepEqual(got.json().deniedRoots, [canonicalizeDeniedRoot(denied)]);
        assert.equal(got.json().source, 'preferences');

        const cleared = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: [] },
        });
        assert.equal(cleared.statusCode, 200);
        const unblocked = await validateProjectPathDetailed(denied);
        assert.equal(unblocked.ok, true, 'clearing the custom list hot-applies too');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(denied, { recursive: true, force: true });
      rmSync(allowed, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('env value is a read-only fallback: GET reports the canonical value without persisting it, and an env-only /tmp entry still blocks validation', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    const legacyPath = '/tmp/f770-denied-roots-legacy';
    delete process.env.PROJECT_DENIED_ROOTS;
    try {
      process.env.PROJECT_DENIED_ROOTS = legacyPath;
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const first = await app.inject({ method: 'GET', url: '/api/config/denied-roots' });
        assert.equal(first.statusCode, 200);
        const firstBody = first.json();
        assert.deepEqual(firstBody.deniedRoots, [canonicalizeDeniedRoot(legacyPath)]);
        assert.equal(firstBody.source, 'env-fallback');
        assert.equal(firstBody.migratedFromEnv, false);

        // A GET must not write: the JSON store stays untouched — only an
        // intentional PUT persists (same read-only-fallback contract as log
        // level and data retention).
        const { readUserPreferences } = await import('../dist/config/user-preferences-store.js');
        assert.equal(readUserPreferences(tempRoot).deniedRoots, undefined);

        // Second read still comes from env — nothing was persisted on the first.
        const second = await app.inject({ method: 'GET', url: '/api/config/denied-roots' });
        assert.equal(second.json().source, 'env-fallback');
        assert.deepEqual(second.json().deniedRoots, [canonicalizeDeniedRoot(legacyPath)]);

        // The guard: an env-only user who typed '/tmp/...' must still be
        // blocked. The env fallback is canonicalized once at wiring into the
        // in-memory validation snapshot, so it matches the realpath'd candidate.
        mkdirSync(legacyPath, { recursive: true });
        const blocked = await validateProjectPathDetailed(legacyPath);
        assert.equal(
          blocked.ok,
          false,
          `env-only /tmp entry must block its realpath'd candidate: ${JSON.stringify(blocked)}`,
        );
        assert.equal(blocked.reason, 'denied_root');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(legacyPath, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('an empty array is a deliberate stored state: it overrides the env fallback (no security resurrection)', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const legacyPath = '/tmp/f770-denied-roots-legacy';
        process.env.PROJECT_DENIED_ROOTS = legacyPath;

        const cleared = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: [] },
        });
        assert.equal(cleared.statusCode, 200, `PUT rejected: ${cleared.payload}`);

        const got = await app.inject({ method: 'GET', url: '/api/config/denied-roots' });
        assert.deepEqual(got.json().deniedRoots, [], 'empty array must be honored as the stored state');
        assert.equal(got.json().source, 'preferences', 'env fallback must NOT revive after an intentional clear');

        const { readUserPreferences } = await import('../dist/config/user-preferences-store.js');
        assert.deepEqual(readUserPreferences(tempRoot).deniedRoots, []);

        assert.equal(
          isUnderAllowedRoot(`${canonicalizeDeniedRoot(legacyPath)}/sub`),
          true,
          'a path only denied by the cleared env value must be allowed again',
        );
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('trims, dedupes and drops empty entries; rejects relative paths with 400 and leaves the store untouched', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const cleaned = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: {
            deniedRoots: ['  /tmp/f770-dedupe  ', '/tmp/f770-dedupe', '', '   ', '/tmp/f770-other'],
          },
        });
        assert.equal(cleaned.statusCode, 200, `PUT rejected: ${cleaned.payload}`);
        assert.deepEqual(cleaned.json().deniedRoots, [
          canonicalizeDeniedRoot('/tmp/f770-dedupe'),
          canonicalizeDeniedRoot('/tmp/f770-other'),
        ]);

        const relative = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: ['/tmp/ok', 'relative/path'] },
        });
        assert.equal(relative.statusCode, 400, 'relative paths must be rejected');
        assert.match(relative.json().error, /deniedRoots\[1\]/);

        // The rejected PUT must not touch the stored value.
        const got = await app.inject({ method: 'GET', url: '/api/config/denied-roots' });
        assert.deepEqual(got.json().deniedRoots, [
          canonicalizeDeniedRoot('/tmp/f770-dedupe'),
          canonicalizeDeniedRoot('/tmp/f770-other'),
        ]);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('rejects writes without identity and writes from a non-owner', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const savedOwner = process.env.DEFAULT_OWNER_USER_ID;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const noIdentity = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          payload: { deniedRoots: ['/tmp/x'] },
        });
        assert.equal(noIdentity.statusCode, 400);

        process.env.DEFAULT_OWNER_USER_ID = 'owner-real';
        const wrongUser = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'intruder' },
          payload: { deniedRoots: ['/tmp/x'] },
        });
        assert.equal(wrongUser.statusCode, 403);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      if (savedOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = savedOwner;
      setDeniedRootsProvider(null);
    }
  });
});

describe('#770 F770: stored roots are canonical (symlink-safe)', () => {
  it("canonicalizes macOS /private symlinks at save time so literal '/tmp/x' input actually blocks its real path", async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    const literal = '/tmp/f770-symlink-canonical';
    const canonical = canonicalizeDeniedRoot(literal);
    mkdirSync(literal, { recursive: true });
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: [literal] },
        });
        assert.equal(res.statusCode, 200, `PUT rejected: ${res.payload}`);
        assert.notEqual(
          canonical,
          resolve(literal),
          'test premise: on this platform the canonical path must differ from the literal input',
        );
        assert.deepEqual(res.json().deniedRoots, [canonical], 'GET must return the canonical stored root');

        // The exact scenario opus found: user types '/tmp/...', validation
        // realpaths to '/private/tmp/...' — the stored root must match.
        const blocked = await validateProjectPathDetailed(literal);
        assert.equal(
          blocked.ok,
          false,
          `literal input must block its realpath'd candidate: ${JSON.stringify(blocked)}`,
        );
        assert.equal(blocked.reason, 'denied_root');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(literal, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('tolerates not-yet-existing directories: save succeeds now and blocks once the directory appears', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    delete process.env.PROJECT_DENIED_ROOTS;
    const literal = '/tmp/f770-not-yet-existing';
    const canonical = canonicalizeDeniedRoot(literal);
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/config/denied-roots',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { deniedRoots: [literal] },
        });
        assert.equal(res.statusCode, 200, `realpath failure on a missing dir must not 400 the save: ${res.payload}`);
        assert.deepEqual(res.json().deniedRoots, [canonical]);

        // Once the directory comes into existence, the pre-canonicalized root matches.
        mkdirSync(literal, { recursive: true });
        const blocked = await validateProjectPathDetailed(literal);
        assert.equal(blocked.ok, false, 'a denied root created after the save must be blocked');
        assert.equal(blocked.reason, 'denied_root');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(literal, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });
});

describe('#770 F770: the env double source is eliminated', () => {
  it('PATCH /api/config/env rejects PROJECT_DENIED_ROOTS and the system surface no longer lists it', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    writeFileSync(envFilePath, `PROJECT_DENIED_ROOTS=/tmp/legacy${delimiter}/tmp/other\nOTHER_KEY=keep\n`, 'utf8');
    process.env.PROJECT_DENIED_ROOTS = `/tmp/legacy${delimiter}/tmp/other`;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/config/env',
          headers: { 'x-cat-cafe-user': 'codex' },
          payload: { updates: [{ name: 'PROJECT_DENIED_ROOTS', value: '/tmp/evil' }] },
        });
        assert.equal(res.statusCode, 400, `PROJECT_DENIED_ROOTS must no longer be env-editable: ${res.payload}`);
        assert.match(res.json().error, /not editable/);

        // The rejection must happen before ANY write: .env byte-identical.
        assert.equal(
          readFileSync(envFilePath, 'utf8'),
          `PROJECT_DENIED_ROOTS=/tmp/legacy${delimiter}/tmp/other\nOTHER_KEY=keep\n`,
          'rejected PATCH must not touch .env at all',
        );

        const summary = await app.inject({ method: 'GET', url: '/api/config/env-summary?surface=system' });
        assert.equal(summary.statusCode, 200);
        const entry = JSON.parse(summary.payload).variables.find((v) => v.name === 'PROJECT_DENIED_ROOTS');
        assert.equal(entry, undefined, 'deprecated PROJECT_DENIED_ROOTS must be gone from the system surface');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });
});

describe('#770 F770: fail-closed degradation', () => {
  it('with the JSON provider unwired, platform default denied roots still block (never unrestricted)', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    const { tempRoot, envFilePath } = tempSetup();
    const envDenied = mkdtempSync(resolve(tmpdir(), 'f770-env-fallback-'));
    const unrelated = mkdtempSync(resolve(tmpdir(), 'f770-unrelated-'));
    delete process.env.PROJECT_DENIED_ROOTS;
    try {
      const app = await buildApp(envFilePath, tempRoot);
      try {
        // Simulate boot-time callers that run before config.ts wires the
        // provider: unwind it and confirm validation degrades to platform
        // defaults, NOT to "allow everything". Blocking claims MUST go
        // through the real entry validateProjectPathDetailed — the bare
        // isUnderAllowedRoot helper compares literals and would pass even
        // when realpath'd candidates slip past the denylist.
        setDeniedRootsProvider(null);
        const sysBlocked = await validateProjectPathDetailed('/dev');
        assert.equal(
          sysBlocked.ok,
          false,
          'platform default denied roots must block even when the JSON provider is unwired',
        );
        assert.equal(sysBlocked.reason, 'denied_root');
        const sysFine = await validateProjectPathDetailed(unrelated);
        assert.equal(sysFine.ok, true, 'unrelated paths stay allowed');

        // The legacy env fallback also still applies while unwired.
        process.env.PROJECT_DENIED_ROOTS = envDenied;
        const envBlocked = await validateProjectPathDetailed(envDenied);
        assert.equal(envBlocked.ok, false, 'legacy env fallback must keep working while the JSON provider is unwired');
        assert.equal(envBlocked.reason, 'denied_root');
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(envDenied, { recursive: true, force: true });
      rmSync(unrelated, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      setDeniedRootsProvider(null);
    }
  });

  it('an uninitialized snapshot fails closed: provider wired without init degrades to platform defaults + env, never an empty denylist', async () => {
    const savedEnv = process.env.PROJECT_DENIED_ROOTS;
    delete process.env.PROJECT_DENIED_ROOTS;
    // Own symlink, not macOS /tmp: the env value is the LINK path while the
    // candidate realpaths to the real dir — on any OS the literal link string
    // can never match the realpath'd candidate without canonicalization, so
    // this is red on the un-fixed env branch everywhere (Linux CI included).
    const realRoot = mkdtempSync(resolve(tmpdir(), 'f770-uninit-real-'));
    const linkRoot = resolve(tmpdir(), `f770-uninit-link-${process.pid}`);
    symlinkSync(realRoot, linkRoot, 'dir');
    try {
      process.env.PROJECT_DENIED_ROOTS = linkRoot;
      // Wire the provider WITHOUT initDeniedRootsRuntime — simulates a future
      // wiring reorder. An uninitialized snapshot must read as "no opinion"
      // (null) so DENIED_ROOTS() falls back to platform defaults + the env
      // value. Returning [] here would mean "owner cleared the blacklist"
      // and silently drop the env denylist — the wrong direction for a
      // security control.
      resetDeniedRootsRuntimeForTests();
      setDeniedRootsProvider(getRuntimeDeniedRoots);
      try {
        const sysBlocked = await validateProjectPathDetailed('/dev');
        assert.equal(
          sysBlocked.ok,
          false,
          'platform default denied roots must still block when the snapshot is uninitialized',
        );
        assert.equal(sysBlocked.reason, 'denied_root');
        const viaReal = await validateProjectPathDetailed(realRoot);
        assert.equal(
          viaReal.ok,
          false,
          'the env denylist must block the real directory when the snapshot is uninitialized (fail-closed)',
        );
        assert.equal(viaReal.reason, 'denied_root');
        const viaLink = await validateProjectPathDetailed(linkRoot);
        assert.equal(
          viaLink.ok,
          false,
          'the env denylist must also block through the symlink path it was configured with',
        );
        assert.equal(viaLink.reason, 'denied_root');
        const unrelated = await validateProjectPathDetailed(mkdtempSync(resolve(tmpdir(), 'f770-uninit-unrelated-')));
        assert.equal(unrelated.ok, true, 'unrelated paths stay allowed');
      } finally {
        setDeniedRootsProvider(null);
      }
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
      rmSync(linkRoot, { force: true });
      if (savedEnv === undefined) delete process.env.PROJECT_DENIED_ROOTS;
      else process.env.PROJECT_DENIED_ROOTS = savedEnv;
      resetDeniedRootsRuntimeForTests();
    }
  });
});
