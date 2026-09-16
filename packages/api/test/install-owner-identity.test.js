import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { resolveInstallOwnerUserId } = await import('../dist/config/install-owner.js');

const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

describe('the install has one owner identity', () => {
  it('is the runtime user when no trust anchor is configured', () => {
    assert.equal(resolveInstallOwnerUserId({}), 'default-user');
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'bob' }), 'bob');
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: '  bob  ' }), 'bob');
    // A blank anchor is not a configured owner, exactly as the owner gate reads it.
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'bob', DEFAULT_OWNER_USER_ID: '   ' }), 'bob');
  });

  it('is that user when the trust anchor names the same one', () => {
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'alice', DEFAULT_OWNER_USER_ID: 'alice' }), 'alice');
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'alice', DEFAULT_OWNER_USER_ID: '  alice  ' }), 'alice');
    // CI's own lane: the anchor is set to the default runtime user.
    assert.equal(resolveInstallOwnerUserId({ DEFAULT_OWNER_USER_ID: 'default-user' }), 'default-user');
  });

  it('refuses to boot when the trust anchor names someone else', () => {
    // The owner gate would trust "alice" while sessions, runtime data and lifecycle
    // spaces belong to "default-user": every privileged gate fails for the only
    // session this install mints on loopback.
    assert.throws(
      () => resolveInstallOwnerUserId({ DEFAULT_OWNER_USER_ID: 'alice' }),
      (error) => {
        assert.match(error.message, /DEFAULT_OWNER_USER_ID \("alice"\)/);
        assert.match(error.message, /CAT_CAFE_USER_ID \("default-user"\)/);
        assert.match(error.message, /single owner/);
        return true;
      },
    );
    // The reachable "authorized, then 404" shape: a remote session is minted as
    // default-user, passes the anchor gate, and lands outside the install's space.
    assert.throws(
      () => resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'bob', DEFAULT_OWNER_USER_ID: 'default-user' }),
      /name different users/,
    );
    assert.throws(
      () => resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'bob', DEFAULT_OWNER_USER_ID: 'alice' }),
      /name different users/,
    );
  });

  it('rejects a blank runtime user', () => {
    assert.throws(() => resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: '   ' }), /must not be blank/);
  });

  it('is derived once in the composition, and every owner consumer uses it', () => {
    assert.equal(indexSource.match(/resolveInstallOwnerUserId\(/g).length, 1);
    assert.equal(indexSource.includes("import { resolveInstallOwnerUserId } from './config/install-owner.js';"), true);
    assert.match(indexSource, /const privateUserId = resolveInstallOwnerUserId\(\);/);
    // No second derivation of the install owner may reappear in the composition.
    assert.equal(indexSource.includes("CAT_CAFE_USER_ID ?? 'default-user'"), false);
    // The session the install mints is pinned by the F255 startup-owner guard in
    // test/auto-dream-index-wiring.test.js; here we hold the F257 consumers.
    const configuredOwnerValues = [...indexSource.matchAll(/configuredOwnerUserId: ([A-Za-z0-9_.]+)/g)].map(
      (match) => match[1],
    );
    assert.ok(configuredOwnerValues.length >= 2, `expected configured-owner consumers, saw ${configuredOwnerValues}`);
    assert.deepEqual([...new Set(configuredOwnerValues)], ['privateUserId']);
  });
});
