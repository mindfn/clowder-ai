import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

// Real Settings/Members editor and browser. HTTP is an isolated fixture; API persistence has its own Fastify test.
test('Gemini Native entry saves an explicit isolated profile, survives reload, and returns to CLI', async () => {
  const { context, page, state } = await scene(1440, false, false, false, {
    accounts: [
      {
        id: 'gemini',
        name: 'Gemini',
        displayName: 'Gemini OAuth',
        clientId: 'google',
        authType: 'oauth',
        builtin: true,
        models: [],
      },
    ],
  });
  try {
    Object.assign(state.cats[0], { clientId: 'google', accountRef: 'gemini', defaultModel: 'Gemini 3.8 Flash (High)' });
    await page.reload();
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.getByLabel('Transport', { exact: true }).selectOption('agy-native');
    await page.getByTestId('agy-native-settings').waitFor();
    await page.getByLabel('Model', { exact: true }).fill('gemini-3.8-flash-high');
    await page.getByLabel('隔离 Profile ID', { exact: true }).fill('gemini38');
    await page.getByLabel('Profile 根目录', { exact: true }).fill('/isolated/profiles');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: /批准工作区/ })
      .waitFor();
    assert.equal(state.writes.filter((write) => write.path.startsWith('/api/cats/')).length, 0);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'native-workspace-required.png') });
    await page.getByLabel('批准工作区', { exact: true }).fill('/approved/workspace');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'native-ready.png') });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    const writes = state.writes.filter((write) => write.path === '/api/cats/fixture-a');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body.agyProfile, {
      enabled: true,
      carrier: 'native',
      profileId: 'gemini38',
      homeRoot: '/isolated/profiles',
      model: 'gemini-3.8-flash-high',
      autoApprove: false,
      trustedWorkspaces: ['/approved/workspace'],
    });
    assert.equal(writes[0].body.agyProfile.nativeCodingGrant, undefined);
    await page.reload();
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    assert.equal(await page.getByLabel('Transport', { exact: true }).inputValue(), 'agy-native');
    assert.equal(await page.getByLabel('批准工作区', { exact: true }).inputValue(), '/approved/workspace');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'native-saved.png') });
    await page.getByLabel('Transport', { exact: true }).selectOption('cli');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    assert.equal(state.writes.filter((write) => write.path === '/api/cats/fixture-a').at(-1).body.agyProfile, null);
  } finally {
    await context.close();
  }
});
