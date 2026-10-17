import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

for (const [width, language, classic, dark] of [
  [1440, 'zh', false, false],
  [390, 'en', false, true],
  [390, 'zh', true, false],
]) {
  test(`member save redo: visible actions, no-op, validation, failure, retry and reopen (${width}/${language}/${classic ? 'classic' : 'v2'})`, async () => {
    const { context, page, state } = await scene(width, dark, classic);
    const en = language === 'en';
    const save = () => page.getByRole('button', { name: en ? 'Save' : '保存', exact: true });
    const footer = page.getByTestId('member-save-feedback');
    try {
      await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
      await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
      await save().waitFor();
      const visible = () =>
        save().evaluate((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return r.top >= 0 && r.bottom <= innerHeight && (hit === button || button.contains(hit));
        });
      assert.equal(await visible(), true, 'Save is visible and hittable immediately on entry');
      assert.equal(await save().isEnabled(), true);
      const brand = await save().evaluate((button) => getComputedStyle(button).backgroundColor);
      await save().click();
      await footer.getByText(en ? 'There are no changes to save' : '没有要保存的修改', { exact: true }).waitFor();
      assert.equal(state.writes.length, 0);
      await page.locator('input[aria-label="Name"]').fill('');
      await save().click();
      await footer.getByRole('alert').waitFor();
      assert.equal(state.writes.length, 0);
      await page.locator('input[aria-label="Name"]').fill('隔离测试甲');
      await page.locator('input[aria-label="Model"]').fill('saved-model');
      await page.locator('input[aria-label="Nickname"]').fill('Changed nickname');
      await page.locator('input[aria-label="Nickname"]').scrollIntoViewIfNeeded();
      assert.equal(await visible(), true, 'Save remains visible deep in the form');
      assert.equal(await save().evaluate((button) => getComputedStyle(button).backgroundColor), brand);
      assert.equal(
        await page
          .locator('input[aria-label="Model"]')
          .evaluate(
            (input) =>
              input.closest('label')?.textContent.includes('Changed') ||
              input.closest('label')?.textContent.includes('已改'),
          ),
        true,
      );
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `redo-dirty-${width}-${language}-${classic}.png`) });
      state.rejectSave = true;
      await save().click();
      await footer.getByRole('alert').filter({ hasText: '没有权限' }).waitFor();
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), 'saved-model');
      state.rejectSave = false;
      await footer.getByRole('button', { name: en ? 'Retry save' : '重新保存', exact: true }).click();
      await footer
        .getByRole('status')
        .filter({ hasText: en ? 'Saved' : '已保存' })
        .waitFor();
      assert.equal(state.cats[0].defaultModel, 'saved-model');
      assert.equal(await save().isEnabled(), true);
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `redo-saved-${width}-${language}-${classic}.png`) });
      if (classic) await page.getByRole('button', { name: '关闭', exact: true }).click();
      else await page.getByRole('button', { name: en ? '‹ Members' : '‹ 成员', exact: true }).click();
      await page.getByRole('button', { name: /Changed nickname.*fixture-a/ }).click();
      assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), 'saved-model');
      assert.equal(await visible(), true);
      assert.equal(await page.locator('#member-history').count(), 0);
    } finally {
      await context.close();
    }
  });
}

for (const [width, language, classic] of [
  [1440, 'zh', false],
  [390, 'en', true],
]) {
  test(`member operation failures retain context and retry the original action (${width}/${language}/${classic ? 'classic' : 'v2'})`, async () => {
    const { context, page, state } = await scene(width, false, classic);
    const en = language === 'en';
    const footer = page.getByTestId('member-save-feedback');
    const save = () => footer.getByRole('button', { name: en ? 'Save' : '保存', exact: true });
    let rejectAccounts = true;
    let accountReads = 0;
    await page.route('**/api/accounts', async (route) => {
      accountReads++;
      return route.fulfill({
        status: rejectAccounts ? 503 : 200,
        json: rejectAccounts ? { error: 'Accounts unavailable' } : { providers: state.accounts },
      });
    });
    try {
      await page.evaluate((value) => window.f322MemberFixture.writeLanguage(value), language);
      await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
      const accounts = page.getByTestId('member-operation-accounts');
      await accounts.getByRole('button', { name: en ? 'Reload accounts' : '重新加载账号' }).waitFor();
      assert.doesNotMatch(await footer.innerText(), /Not saved|没保存上|Retry save|重新保存/);
      await save().click();
      assert.equal(await accounts.isVisible(), true, 'No-op Save cannot clear an unrelated load error');
      await page.locator('input[aria-label="Nickname"]').fill('Keep this draft');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `operation-accounts-${language}.png`) });
      const previousReads = accountReads;
      rejectAccounts = false;
      await accounts.getByRole('button').click();
      await accounts.waitFor({ state: 'detached' });
      assert.equal(accountReads, previousReads + 1, 'Retry must perform a fresh account read');
      assert.equal(await page.locator('input[aria-label="Nickname"]').inputValue(), 'Keep this draft');
      assert.equal(state.writes.length, 0);

      for (const [kind, url, mime, retryLabel] of [
        ['avatar', 'avatar', 'image/png', en ? 'Retry avatar upload' : '重新上传头像'],
        ['audio', 'ref-audio', 'audio/wav', en ? 'Retry audio upload' : '重新上传参考音频'],
      ]) {
        let rejectUpload = true;
        const bodies = [];
        await page.route(`**/api/uploads/${url}`, async (route) => {
          bodies.push(route.request().postDataBuffer());
          return route.fulfill({
            status: rejectUpload ? 503 : 200,
            json: rejectUpload ? { error: `${kind} unavailable` } : { url: `/uploads/retried-${kind}` },
          });
        });
        if (kind === 'audio' && classic) await page.getByRole('button', { name: /Voice Config/ }).click();
        await page.locator(`input[type="file"][accept^="${mime}"]`).setInputFiles({
          name: `sample.${kind === 'avatar' ? 'png' : 'wav'}`,
          mimeType: mime,
          buffer: Buffer.from(`retained-${kind}-file`),
        });
        const issue = page.getByTestId(`member-operation-${kind}`);
        await issue.getByRole('button', { name: retryLabel }).waitFor();
        await issue.scrollIntoViewIfNeeded();
        assert.equal(
          await save().evaluate((button) => {
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return r.top >= 0 && r.bottom <= innerHeight && (hit === button || button.contains(hit));
          }),
          true,
          'Save stays visible and hittable beside the field failure',
        );
        if (classic) {
          const dialog = await page.getByRole('dialog').boundingBox();
          const bar = await page.locator('.member-save-modal').boundingBox();
          assert.ok(dialog && bar);
          assert.ok(
            Math.abs(bar.y + bar.height - dialog.y - dialog.height) < 1,
            'The modal footer stays at the dialog bottom after deep scrolling',
          );
        }
        assert.doesNotMatch(await footer.innerText(), /Not saved|没保存上|Retry save|重新保存/);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `operation-${kind}-${language}.png`) });
        rejectUpload = false;
        await issue.getByRole('button').click();
        await issue.waitFor({ state: 'detached' });
        assert.equal(bodies.length, 2);
        for (const body of bodies) assert.ok(body.includes(Buffer.from(`retained-${kind}-file`)));
        assert.equal(await page.locator('input[aria-label="Nickname"]').inputValue(), 'Keep this draft');
        assert.equal(state.writes.length, 0, 'Upload retry does not silently save the member');
      }
    } finally {
      await context.close();
    }
  });
}
