import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { installOwnerUserId, resolveInstallOwnerUserId } = await import('../dist/config/install-owner.js');
const { getOwnerUserId } = await import('../dist/config/cat-config-loader.js');

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const indexSource = read('../src/index.ts');
const loaderSource = read('../src/config/cat-config-loader.ts');

describe('the install has one owner identity', () => {
  it('is the runtime user when no trust anchor is configured', () => {
    assert.equal(installOwnerUserId({}), 'default-user');
    assert.equal(installOwnerUserId({ CAT_CAFE_USER_ID: 'bob' }), 'bob');
    assert.equal(installOwnerUserId({ CAT_CAFE_USER_ID: '  bob  ' }), 'bob');
    // A blank anchor is not a configured owner, exactly as the owner gate reads it.
    assert.equal(installOwnerUserId({ CAT_CAFE_USER_ID: 'bob', DEFAULT_OWNER_USER_ID: '   ' }), 'bob');
  });

  it('is that user when the trust anchor names the same one', () => {
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'alice', DEFAULT_OWNER_USER_ID: 'alice' }), 'alice');
    assert.equal(resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: 'alice', DEFAULT_OWNER_USER_ID: ' alice ' }), 'alice');
    // CI's own lane: the anchor is set to the default runtime user.
    assert.equal(resolveInstallOwnerUserId({ DEFAULT_OWNER_USER_ID: 'default-user' }), 'default-user');
  });

  it('refuses to boot when the trust anchor names someone else', () => {
    // A loopback session is minted as CAT_CAFE_USER_ID, so an anchor naming someone
    // else fails every privileged gate install-wide.
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
    assert.throws(() => installOwnerUserId({ CAT_CAFE_USER_ID: '   ' }), /must not be blank/);
    assert.throws(() => resolveInstallOwnerUserId({ CAT_CAFE_USER_ID: '   ' }), /must not be blank/);
  });

  // The scheduler, publisher and agent-key consumers reach the owner through
  // getOwnerUserId, while the composition root boots from install-owner. A
  // single-user install with a custom runtime user used to split those two apart:
  // the F257 scheduler published artifacts as default-user while lifecycle scanned
  // the real owner's partition.
  it('answers with the same user through every owner accessor', () => {
    for (const env of [
      {},
      { CAT_CAFE_USER_ID: 'bob' },
      { CAT_CAFE_USER_ID: 'alice', DEFAULT_OWNER_USER_ID: 'alice' },
      { DEFAULT_OWNER_USER_ID: 'default-user' },
    ]) {
      assert.equal(getOwnerUserId(env), installOwnerUserId(env), `getOwnerUserId disagrees for ${JSON.stringify(env)}`);
    }
    // The exact split sol measured: install owner bob, scheduled owner default-user.
    assert.equal(getOwnerUserId({ CAT_CAFE_USER_ID: 'bob' }), 'bob');
    assert.equal(loaderSource.includes("env.DEFAULT_OWNER_USER_ID?.trim() || 'default-user'"), false);
    assert.match(loaderSource, /return installOwnerUserId\(env\);/);
  });

  it('is derived once in the composition, and every owner consumer reads it', () => {
    assert.equal(indexSource.match(/resolveInstallOwnerUserId\(/g).length, 1);
    assert.match(indexSource, /const privateUserId = resolveInstallOwnerUserId\(\);/);
    // No second derivation or second accessor may reappear in the composition.
    assert.equal(indexSource.includes("CAT_CAFE_USER_ID ?? 'default-user'"), false);
    assert.equal(indexSource.includes('getOwnerUserId'), false);
    // Nor may it hardcode the owner: memory indexing and the connector gateway used
    // to pin 'default-user', so a custom runtime owner indexed an empty partition and
    // got connector threads it could not see.
    assert.equal(indexSource.includes("'default-user'"), false);
    // Session minting is also pinned by the F255 startup-owner guard in
    // test/auto-dream-index-wiring.test.js; the rest are this slice's consumers.
    assert.match(indexSource, /sessionRoute, \{ ownerUserId: privateUserId \}/);
    assert.ok(
      indexSource.match(/defaultUserId: privateUserId,/g).length >= 3,
      'scheduler backfill, eval schedule and custody wake sender must read the install owner',
    );
    const configuredOwnerValues = [...indexSource.matchAll(/configuredOwnerUserId: ([A-Za-z0-9_.]+)/g)].map(
      (match) => match[1],
    );
    assert.ok(configuredOwnerValues.length >= 2, `expected configured-owner consumers, saw ${configuredOwnerValues}`);
    assert.deepEqual([...new Set(configuredOwnerValues)], ['privateUserId']);
  });
});
