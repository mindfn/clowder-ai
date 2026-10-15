import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureNamedAlphaRedisIdentity,
  pingNamedAlphaRedis,
  verifyNamedAlphaRedisIdentity,
} from './alpha-redis-process.mjs';
import { redisFixture } from './alpha-redis-process-test-fixture.mjs';

const listenerTimeout = () => Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' });

test('a transient listener timeout reobserves the complete Redis identity before granting ownership', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  for (const operation of [
    (deps) => captureNamedAlphaRedisIdentity(f.raw, deps),
    (deps) => verifyNamedAlphaRedisIdentity(f.raw, proof, deps),
  ]) {
    let reads = 0;
    const value = operation({
      ...f.deps,
      readListeners: () => {
        if (++reads === 1) throw listenerTimeout();
        return [proof.pid];
      },
    });
    assert.ok(value);
    assert.equal(reads, 2);
  }
});

test('listener reobservation never accepts replacement, stale scope or an exhausted budget', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  for (const failAgain of [true, false]) {
    let reads = 0;
    assert.throws(
      () =>
        verifyNamedAlphaRedisIdentity(f.raw, proof, {
          ...f.deps,
          readListeners: () => {
            reads += 1;
            if (reads === 1 || failAgain) throw listenerTimeout();
            return [proof.pid + 1];
          },
        }),
      failAgain ? /ETIMEDOUT/ : /replaced/,
    );
    assert.equal(reads, 2, 'one bounded retry, not an unbounded polling loop');
  }
  let elapsed = 0;
  let reads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        ...f.deps,
        observationNow: () => elapsed,
        readListeners: () => {
          if (++reads === 1) throw listenerTimeout();
          elapsed += 1001;
          return [proof.pid];
        },
      }),
    /budget|deadline/,
  );
  assert.equal(reads, 2);
  reads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        ...f.deps,
        readListeners: () => {
          reads += 1;
          f.f.git(['checkout', '--detach'], f.f.alphaRoot);
          throw listenerTimeout();
        },
      }),
    /checkout|branch|target/i,
  );
  assert.equal(reads, 1, 'retry revalidates the entire Git scope before another listener read');
});

test('a new incarnation after listener timeout cannot receive a protocol command', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  let reads = 0;
  let commands = 0;
  assert.throws(
    () =>
      pingNamedAlphaRedis(f.raw, proof, {
        readListeners: () => {
          if (++reads === 1) throw listenerTimeout();
          return [proof.pid];
        },
        capture: () => ({ ...f.identity, startedAtEpochMs: f.identity.startedAtEpochMs + 1000 }),
        run: () => {
          commands += 1;
          return 'PONG';
        },
      }),
    /incarnation changed/,
  );
  assert.equal(reads, 2);
  assert.equal(commands, 0);
});
