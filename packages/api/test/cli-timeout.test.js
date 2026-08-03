import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  DEFAULT_CLI_TIMEOUT_MS,
  INVOCATION_TIMEOUT_MULTIPLIER,
  MAX_CLI_TIMEOUT_MS,
  parseCliTimeoutMs,
  readCliTimeoutMsFromEnv,
  resolveCliTimeoutMs,
} = await import('../dist/utils/cli-timeout.js');

describe('cli-timeout', () => {
  describe('shared constants', () => {
    it('MAX_CLI_TIMEOUT_MS = floor((2^31-1) / INVOCATION_TIMEOUT_MULTIPLIER)', () => {
      assert.equal(MAX_CLI_TIMEOUT_MS, Math.floor((2 ** 31 - 1) / INVOCATION_TIMEOUT_MULTIPLIER));
      assert.equal(INVOCATION_TIMEOUT_MULTIPLIER, 2);
      // Derived value must equal 1073741823
      assert.equal(MAX_CLI_TIMEOUT_MS, 1073741823);
    });

    it('MAX × MULTIPLIER fits in a 32-bit signed integer for setTimeout', () => {
      const maxTimerMs = MAX_CLI_TIMEOUT_MS * INVOCATION_TIMEOUT_MULTIPLIER;
      assert.ok(maxTimerMs <= 2 ** 31 - 1, `${maxTimerMs} must be <= 2^31-1`);
    });
  });

  describe('parseCliTimeoutMs', () => {
    it('returns undefined for missing or invalid values', () => {
      assert.equal(parseCliTimeoutMs(undefined), undefined);
      assert.equal(parseCliTimeoutMs(''), undefined);
      assert.equal(parseCliTimeoutMs('   '), undefined);
      assert.equal(parseCliTimeoutMs('-1'), undefined);
      assert.equal(parseCliTimeoutMs('NaN'), undefined);
      assert.equal(parseCliTimeoutMs('Infinity'), undefined);
    });

    it('accepts zero and positive finite numbers within safe range', () => {
      assert.equal(parseCliTimeoutMs('0'), 0);
      assert.equal(parseCliTimeoutMs('300000'), 300000);
      assert.equal(parseCliTimeoutMs(' 1500 '), 1500);
    });

    it('accepts MAX_CLI_TIMEOUT_MS exactly', () => {
      assert.equal(parseCliTimeoutMs(String(MAX_CLI_TIMEOUT_MS)), MAX_CLI_TIMEOUT_MS);
    });

    it('rejects values above MAX_CLI_TIMEOUT_MS (timer overflow)', () => {
      assert.equal(parseCliTimeoutMs(String(MAX_CLI_TIMEOUT_MS + 1)), undefined);
      assert.equal(parseCliTimeoutMs('2147483647'), undefined); // 2^31-1
      assert.equal(parseCliTimeoutMs('99999999999'), undefined);
    });
  });

  describe('readCliTimeoutMsFromEnv', () => {
    it('reads CLI_TIMEOUT_MS from env-like objects', () => {
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '0' }), 0);
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '9000' }), 9000);
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '-5' }), undefined);
    });
  });

  describe('readCliTimeoutMsFromEnv — timer overflow via env', () => {
    it('rejects overflow values from env-like objects', () => {
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: String(MAX_CLI_TIMEOUT_MS) }), MAX_CLI_TIMEOUT_MS);
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: String(MAX_CLI_TIMEOUT_MS + 1) }), undefined);
    });
  });

  describe('resolveCliTimeoutMs', () => {
    it('prefers explicit override, then env, then fallback default', () => {
      assert.equal(resolveCliTimeoutMs(42, { CLI_TIMEOUT_MS: '9000' }), 42);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: '9000' }), 9000);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: '0' }), 0);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: 'NaN' }), DEFAULT_CLI_TIMEOUT_MS);
      assert.equal(resolveCliTimeoutMs(undefined, {}), DEFAULT_CLI_TIMEOUT_MS);
    });
  });
});

describe('ConfigStore — cli.timeoutMs timer overflow boundary', () => {
  let configStore;

  // Reset after each test to avoid leaking env
  const restore = () => {
    try {
      configStore.reset();
    } catch {
      /* ignore */
    }
  };

  it('imports and uses the same MAX_CLI_TIMEOUT_MS boundary', async () => {
    const mod = await import('../dist/config/ConfigStore.js');
    configStore = mod.configStore;

    // Accept max boundary value
    configStore.set('cli.timeoutMs', MAX_CLI_TIMEOUT_MS);
    assert.equal(configStore.get('cli.timeoutMs'), String(MAX_CLI_TIMEOUT_MS));
    restore();

    // Reject overflow
    assert.throws(
      () => configStore.set('cli.timeoutMs', MAX_CLI_TIMEOUT_MS + 1),
      /invalid value/i,
      'ConfigStore must reject values above MAX_CLI_TIMEOUT_MS',
    );
    restore();
  });
});
