import { chromium } from 'file:///Users/lang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Users/lang/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return url.origin === 'http://127.0.0.1:49173' ? route.continue() : route.abort();
});
try {
  await page.goto('http://127.0.0.1:49173/');
  await page.getByPlaceholder('继续输入，消息可不中断追加给当前成员...').waitFor();
  assert.equal(await page.getByTestId('active-invocation-banner').count(), 0);
  const stop = page.getByRole('button', { name: 'Stop generation', exact: true });
  assert.equal(await stop.count(), 1);
  assert.equal(await stop.getAttribute('title'), '停止当前对话全部回复');
  assert.notEqual(await stop.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  const delivered = page.getByRole('button', { name: /^lang · 投递于: 10\/09 12:26:02 · / });
  await delivered.hover();
  await page.getByRole('tooltip').filter({ hasText: '投递于: 10/09 12:26:02' }).waitFor();
  assert.equal(await page.getByText('读取状态不可用', { exact: false }).count(), 0);
  await page.screenshot({ path: '/tmp/f117-feedback-preview.png', fullPage: true });
  await page.keyboard.press('Escape');
  const read = page.getByRole('button', { name: /^lang · 读取于: 10\/09 12:26:03 · / });
  await read.hover();
  await page.getByRole('tooltip').filter({ hasText: '读取于: 10/09 12:26:03' }).waitFor();
  await page.screenshot({ path: '/tmp/f117-feedback-preview-read.png', fullPage: true });
  const color = await page
    .locator('[data-append-delivery-state] span')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(color, 'rgb(167, 139, 250)');
  assert.equal(await page.getByText('展开全文', { exact: true }).count(), 0);
  await delivered.click();
  assert.equal(await delivered.getAttribute('aria-expanded'), 'true');
  await delivered.press('Enter');
  assert.equal(await delivered.getAttribute('aria-expanded'), 'false');
  await stop.click();
  await page.waitForFunction(
    () => window.fixtureRequests.filter((request) => request.path.includes('/cancel')).length === 2,
  );
  const cancels = await page.evaluate(() =>
    window.fixtureRequests.filter((request) => request.path.includes('/cancel')),
  );
  assert.deepEqual(cancels.map((request) => JSON.parse(request.body).catId).sort(), ['codex', 'opus']);
  assert.equal(await page.getByText('猫猫正在回复中', { exact: false }).count(), 0);
  await page.setViewportSize({ width: 430, height: 800 });
  await page.reload();
  await page.getByPlaceholder('继续输入，消息可不中断追加给当前成员...').waitFor();
  const bounds = await page.getByRole('button', { name: 'Stop generation', exact: true }).boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 430);
  await page.screenshot({ path: '/tmp/f117-feedback-preview-mobile.png', fullPage: true });
  assert.equal(errors.length, 0);
  const result = {
    kind: 'current-components-with-in-memory-API',
    url: 'http://127.0.0.1:49173/',
    runtimeDataUsed: false,
    providerUsed: false,
    duplicateBanner: false,
    themeDot: color,
    exactDeliveryAndReadTooltips: true,
    messageRowToggle: true,
    keyboardToggle: true,
    tooltipDelayMs: 1000,
    cancelTargets: cancels,
    mobileStopWithinViewport: true,
    errors,
  };
  await writeFile('/tmp/f117-feedback-preview-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
