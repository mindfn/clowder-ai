// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);

describe('AcpServiceFactory', () => {
  for (const [clientId, provider, defaultModel] of [
    ['opencode', 'zhipu', 'zhipu/glm-5.2'],
    ['google', 'google', 'gemini-test-model'],
    ['kimi', 'kimi', 'kimi-test-model'],
  ]) {
    it(`rebuilds the ${clientId} ACP pool when the derived member context policy changes`, async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), `acp-context-policy-${clientId}-`));
      const profileId = `${clientId}-context-policy`;
      const poolRegistry = new Map();
      const makeConfig = (contextWindow) => ({
        id: profileId,
        name: `${clientId} ACP`,
        displayName: `${clientId} ACP`,
        color: { primary: '#111827', secondary: '#e5e7eb' },
        avatar: '/avatars/default.png',
        mentionPatterns: [`@${profileId}`],
        roleDescription: 'ACP context policy test member',
        clientId,
        provider,
        defaultModel,
        contextWindow,
        mcpSupport: false,
      });
      const baseInput = {
        projectRoot,
        profileId,
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      };

      try {
        assert.ok(await createAcpServiceForConfig({ ...baseInput, config: makeConfig(200_000) }));
        const firstPool = poolRegistry.get(profileId);
        assert.ok(firstPool);
        if (clientId === 'kimi') {
          const client = firstPool.clientFactory();
          assert.equal(client.config.env.KIMI_MODEL_MAX_CONTEXT_SIZE, '200000');
        }
        assert.ok(await createAcpServiceForConfig({ ...baseInput, config: makeConfig(128_000) }));
        const secondPool = poolRegistry.get(profileId);
        assert.ok(secondPool);
        assert.notEqual(secondPool, firstPool, 'policy change must replace the old process pool');
        await assert.rejects(firstPool.acquire({ projectPath: projectRoot, providerProfile: profileId }), /closed/i);
      } finally {
        await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }

  it('uses the active project root when building ACP services', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-active-root-'));
    const poolRegistry = new Map();

    try {
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'active-root-acp',
        config: {
          id: 'active-root-acp',
          name: 'Active Root ACP',
          displayName: 'Active Root ACP',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          avatar: '/avatars/default.png',
          mentionPatterns: ['@active-root-acp'],
          roleDescription: 'ACP test member',
          clientId: 'acp',
          defaultModel: 'test-model',
          mcpSupport: false,
        },
        acpConfig: { command: 'mock-acp', startupArgs: ['--config=./agent.json'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });

      assert.ok(service, 'ACP service should be created for valid generic ACP config');
      assert.equal(service.projectRoot, projectRoot, 'service must retain the active runtime project root');
      assert.equal(service.poolKey.projectPath, projectRoot, 'pool key must be scoped to the active project root');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('skips registration and closes existing pools when bound accountRef is missing', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-missing-account-'));
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
        projectRoot,
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
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
