/**
 * F202 W2-6b — the Host log never receives a raw start error, only a bounded, redacted projection
 * (ledger「W2-6b」(1); astra's design review P1, Host thread …000091). All credentials below are fake.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeErrorProjection } from '../dist/domains/plugin/diagnostics/safe-error-projection.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';

function assertNoFake(projection) {
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /FAKE_W26B/u, text);
}

test("astra's probe: a URL token in the cause and a credential property are both kept out", () => {
  const error = new Error('start failed', {
    cause: new Error('request failed https://example.invalid/?token=FAKE_W26B_QUERY'),
  });
  error.secret = 'FAKE_W26B_PROPERTY';

  const projection = safeErrorProjection(error);

  assertNoFake(projection);
  assert.equal(projection.name, 'Error');
  assert.equal(projection.message, 'start failed');
  assert.equal(projection.cause.message, 'request failed https://example.invalid/[REDACTED]');
});

test('an SDK error object is reduced to name, code, message and frames; its request and response never appear', () => {
  const error = Object.assign(new Error('Request failed with status code 401'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    config: { url: 'https://api.example.invalid/x', headers: { Authorization: 'Bearer FAKE_W26B_HEADER' } },
    request: { _header: 'Cookie: FAKE_W26B_COOKIE' },
    response: { status: 401, data: { access_token: 'FAKE_W26B_BODY' } },
  });

  const projection = safeErrorProjection(error);

  assertNoFake(projection);
  assert.deepEqual(Object.keys(projection).sort(), ['code', 'frames', 'message', 'name']);
  assert.equal(projection.name, 'AxiosError');
  assert.equal(projection.code, 'ERR_BAD_REQUEST');
  assert.equal(projection.message, 'Request failed with status code 401');
});

test('credentials inside message text are redacted, whatever form they take', () => {
  const messages = [
    'auth failed: Authorization: Bearer FAKE_W26B_BEARER',
    'upstream said {"app_secret":"FAKE_W26B_JSON","corpid":"ww1"}',
    'callback token=FAKE_W26B_PAIR&x=1',
    "config appSecret: 'FAKE_W26B_QUOTED'",
    'getMe https://api.telegram.org/bot123456789:AAFAKE_W26B_PATH_abcdefghijklmnop/getMe failed',
    'login https://user:FAKE_W26B_USERINFO@example.invalid failed',
    'key 3f9a8b7c6d5e4f3a2b1c0d9e8FAKE_W26B leaked',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFX1cyNkIifQ.c2lnbmF0dXJlMTIzNDU2Nzg5MA in header',
  ];
  for (const message of messages) {
    const projection = safeErrorProjection(new Error(message));
    assertNoFake(projection);
    assert.match(projection.message, /\[REDACTED\]/u, message);
  }
  const jwt = safeErrorProjection(new Error(messages.at(-1)));
  assert.doesNotMatch(jwt.message, /eyJ/u, 'every JWT segment is opaque');
});

test('ordinary diagnostic text survives redaction', () => {
  const projection = safeErrorProjection(
    new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'official.connector.wecom-bot lacks thread.listMetadata'),
  );
  assert.equal(projection.name, 'ExternalPluginRuntimeError');
  assert.equal(projection.code, 'DELIVERY_REJECTED');
  assert.equal(projection.message, 'official.connector.wecom-bot lacks thread.listMetadata');
  assert.match(
    projection.frames[0],
    /f202-w2-6b-safe-error-projection\.test\.js:\d+:\d+/u,
    'frames keep file and line',
  );

  const refused = safeErrorProjection(new Error('connect ECONNREFUSED 127.0.0.1:443 https://open.feishu.cn/x/y'));
  assert.equal(refused.message, 'connect ECONNREFUSED 127.0.0.1:443 https://open.feishu.cn/[REDACTED]');
});

test('aggregated errors are projected one by one, each redacted, and bounded', () => {
  const inner = Object.assign(new Error('stop failed secret=FAKE_W26B_AGG'), { credentials: 'FAKE_W26B_CRED' });
  const many = Array.from({ length: 50 }, (_, index) => new Error(`rollback ${index}`));
  const projection = safeErrorProjection(new AggregateError([inner, ...many], 'module startup rollback failed'));

  assertNoFake(projection);
  assert.equal(projection.message, 'module startup rollback failed');
  assert.equal(projection.errors.length, 5);
  assert.equal(projection.errors[0].message, 'stop failed secret=[REDACTED]');
});

test('cycles end, depth and size are bounded', () => {
  const first = new Error('first');
  const second = new Error('second', { cause: first });
  first.cause = second;
  const cyclic = safeErrorProjection(first);
  assert.equal(cyclic.cause.message, 'second');
  assert.equal(cyclic.cause.cause, undefined);

  const self = new Error('self');
  self.cause = self;
  assert.equal(safeErrorProjection(self).cause, undefined);

  let deep = new Error('level 0');
  for (let level = 1; level < 50; level += 1) deep = new Error(`level ${level}`, { cause: deep });
  let depth = 0;
  for (let node = safeErrorProjection(deep); node.cause; node = node.cause) depth += 1;
  assert.equal(depth, 4);

  const huge = safeErrorProjection(new Error(`${'x '.repeat(500_000)}token=FAKE_W26B_TAIL`));
  assert.ok(huge.message.length <= 501, `message is bounded (${huge.message.length})`);
  assertNoFake(huge);
});

test('a throwing getter or a hostile proxy yields a partial projection, never an exception', () => {
  const getters = {};
  for (const key of ['message', 'name', 'code', 'stack', 'cause']) {
    Object.defineProperty(getters, key, {
      enumerable: true,
      get() {
        throw new Error('FAKE_W26B_GETTER');
      },
    });
  }
  assert.deepEqual(safeErrorProjection(getters), { name: 'Object', message: '' });

  const hostile = new Proxy(new Error('proxied'), {
    get() {
      throw new Error('FAKE_W26B_TRAP');
    },
    has() {
      throw new Error('FAKE_W26B_TRAP');
    },
    getPrototypeOf() {
      throw new Error('FAKE_W26B_TRAP');
    },
  });
  const projection = safeErrorProjection(hostile);
  assertNoFake(projection);
  assert.equal(projection.message, '');

  const aggregate = new AggregateError([], 'aggregate');
  Object.defineProperty(aggregate, 'errors', {
    get() {
      throw new Error('FAKE_W26B_ERRORS');
    },
  });
  assert.equal(safeErrorProjection(aggregate).errors, undefined);
});

test('values that are not errors are described without being expanded', () => {
  assert.deepEqual(safeErrorProjection('token=FAKE_W26B_STRING'), { name: 'string', message: 'token=[REDACTED]' });
  assert.deepEqual(safeErrorProjection(undefined), { name: 'undefined', message: 'undefined' });
  assert.deepEqual(safeErrorProjection(null), { name: 'null', message: 'null' });
  assert.deepEqual(safeErrorProjection(42), { name: 'number', message: '42' });
  const plain = safeErrorProjection({ apiKey: 'FAKE_W26B_PLAIN', nested: { password: 'FAKE_W26B_NESTED' } });
  assertNoFake(plain);
  assert.deepEqual(plain, { name: 'Object', message: '' });
});

test('a code or name that looks like a credential is dropped', () => {
  const error = Object.assign(new Error('x'), { code: 'AKIA1234567890FAKEW26B', name: 'Tok3n1234567890abcdefXYZ' });
  const projection = safeErrorProjection(error);
  assert.equal(projection.code, undefined);
  assert.equal(projection.name, '[REDACTED]');
  assert.equal(safeErrorProjection(Object.assign(new Error('x'), { code: 40_001 })).code, 40_001);
});
