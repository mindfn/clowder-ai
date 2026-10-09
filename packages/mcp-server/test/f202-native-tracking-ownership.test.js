import assert from 'node:assert/strict';
import { test } from 'node:test';

// The installed package owns these names. Registering them in the Host MCP
// competes with the authenticated, activation-scoped native MCP contribution.
test('Host MCP leaves tracking tools to installed native contributions', async () => {
  const { createServer } = await import('../dist/index.js');
  const server = createServer();
  try {
    for (const name of [
      'cat_cafe_register_pr_tracking',
      'cat_cafe_register_issue_tracking',
      'cat_cafe_unregister_tracking',
    ]) {
      assert.equal(Object.hasOwn(server._registeredTools, name), false, `${name} has a legacy Host owner`);
    }
    assert.ok(server._registeredTools.cat_cafe_register_deployment_wait, 'Host deployment wait remains available');
    assert.ok(server._registeredTools.cat_cafe_list_tasks, 'neutral task access remains available');
  } finally {
    await server.close();
  }
});
