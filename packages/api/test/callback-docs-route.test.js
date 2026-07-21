import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Callback Docs Routes', () => {
  async function createApp() {
    const { registerCallbackDocsRoutes } = await import('../dist/routes/callback-docs-routes.js');
    const app = Fastify();
    await app.register(registerCallbackDocsRoutes);
    await app.ready();
    return app;
  }

  test('GET /api/callbacks/instructions returns 200 with skill content', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/instructions',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.instructions, 'response should have instructions field');
      assert.ok(body.instructions.includes('# MCP Callbacks HTTP API Reference'), 'should contain refs heading');
      assert.ok(!body.instructions.startsWith('---'), 'frontmatter should be stripped');
    } finally {
      await app.close();
    }
  });

  test('GET /api/callbacks/rich-block-rules returns 200 with rules', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/rich-block-rules',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.rules, 'response should have rules field');
      assert.ok(body.rules.length > 0, 'rules should be non-empty');
    } finally {
      await app.close();
    }
  });

  // F257 #3: objective registry discovery route — serves the shipped registry.yaml
  // so cat_cafe_list_objectives can surface valid objectiveIds (no archaeology).
  test('GET /api/callbacks/objectives returns 200 with canonized objectives', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/callbacks/objectives' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(Array.isArray(body.objectives), 'response should have objectives array');
      const ids = body.objectives.map((o) => o.id);
      assert.ok(ids.includes('obj-routing-delivery'), 'obj-routing-delivery served');
      assert.ok(ids.includes('obj-identity-integrity'), 'obj-identity-integrity served');
      for (const o of body.objectives) {
        assert.ok(o.id && o.statement, 'each objective has id + statement');
      }
    } finally {
      await app.close();
    }
  });
});
