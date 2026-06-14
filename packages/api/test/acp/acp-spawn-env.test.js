// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { prepareAcpProcessEnv } = await import('../../dist/domains/cats/services/agents/providers/acp/acp-spawn-env.js');

describe('prepareAcpProcessEnv', () => {
  it('fails fast when a generic ACP api_key account has no API key', () => {
    assert.throws(
      () =>
        prepareAcpProcessEnv({
          clientId: 'acp',
          provider: undefined,
          baseModel: 'deepseek-chat',
          account: {
            id: 'deepseek-key',
            authType: 'api_key',
            envVars: { DEEPSEEK_API_KEY: '${api_key}' },
          },
        }),
      /account "deepseek-key" is configured as api_key but has no API key set/,
    );
  });
});
