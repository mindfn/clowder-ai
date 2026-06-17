// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);

describe('AcpServiceFactory', () => {
  it('skips registration and closes existing pools when bound accountRef is missing', async () => {
    let closed = 0;
    const poolRegistry = new Map([
      [
        'missing-account-acp',
        {
          async closeAll() {
            closed++;
          },
        },
      ],
    ]);

    try {
      const service = await createAcpServiceForConfig({
        profileId: 'missing-account-acp',
        config: {
          id: 'missing-account-acp',
          name: 'Missing Account ACP',
          displayName: 'Missing Account ACP',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          avatar: '/avatars/default.png',
          mentionPatterns: ['@missing-account-acp'],
          roleDescription: 'ACP test member',
          clientId: 'openai',
          provider: 'openai',
          accountRef: 'missing-acp-account',
          defaultModel: 'gpt-test',
          mcpSupport: false,
        },
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });

      assert.equal(service, null, 'missing bound account must skip ACP service registration');
      assert.equal(closed, 1, 'stale pool for missing account binding should be closed');
      assert.equal(poolRegistry.has('missing-account-acp'), false, 'stale pool should be removed from registry');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
    }
  });
});
