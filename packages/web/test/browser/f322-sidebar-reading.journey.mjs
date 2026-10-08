import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { createChatProofApi } from './fixtures/f322-chat-real-page-data.mjs';

// Real Sidebar click, canonical HTTP refresh and Chromium layout. Existing shell
// browser admission is shared; no extra server, Redis, provider or catalog unit.
export async function runSidebarReadingJourney(t, browser) {
  const evidence = process.env.F322_SIDEBAR_READING_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-sidebar-reading');
  mkdirSync(evidence, { recursive: true });
  const built = await buildChatProof();
  for (const [count, deep] of [
    [11, false],
    [260, false],
    [260, true],
  ])
    await t.test(
      `${count} rows ${deep ? 'after scrolling' : 'at top'}: reading a green reply keeps the next click target in place`,
      async () => {
        const label = `${count}${deep ? '-scrolled' : ''}`;
        const target = deep ? 30 : 2;
        const context = await browser.newContext();
        const harness = createChatProofHarness(context, built, evidence, [], (api) => {
          api.preferences.groups = count === 11 ? api.preferences.groups : [];
          api.threads.forEach((row, index) => {
            row.title = `对话 ${index}`;
            row.unreadCount = (deep && index <= target) || index === target ? 1 : 0;
            row.hasUserMention = false;
            row.presence = index === target ? { status: 'done', cats: ['codex61-sol'] } : { status: 'idle' };
          });
          for (let index = api.threads.length; index < count; index++)
            api.threads.push({
              ...api.threads[3],
              id: `extra-${index}`,
              title: `历史 ${index}`,
              lastActiveAt: api.threads[3].lastActiveAt - index * 60_000,
              unreadCount: deep && index <= target ? 1 : 0,
              presence: index === target ? { status: 'done', cats: ['codex61-sol'] } : { status: 'idle' },
            });
        });
        const proof = await harness.openProof();
        const { page, api } = proof;
        const targetId = deep ? 'extra-30' : 'composer-proof-2';
        const nextId = deep ? 'extra-31' : 'composer-proof-3';
        const green = page.locator(`[data-thread-id="${targetId}"]`);
        const next = page.locator(`[data-thread-id="${nextId}"]`);
        let before, after;
        try {
          if (deep) {
            await page.locator('[data-thread-id="composer-proof-0"]').hover();
            await page.mouse.wheel(0, 1550);
            await green.waitFor();
          }
          await green.getByTestId('thread-row-done').waitFor();
          await green.locator('[role="link"]').hover();
          before = { green: await green.boundingBox(), next: await next.boundingBox() };
          await page.screenshot({ path: path.join(evidence, `${label}-before.png`) });
          await green.locator('[role="link"]').click();
          assert.equal(new URL(page.url()).pathname, `/thread/${targetId}`);
          api.threads[target].unreadCount = 0;
          api.threads[target].presence = { status: 'idle' };
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
          await green.getByTestId('thread-row-done').waitFor({ state: 'detached' });
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          after = { green: await green.boundingBox(), next: await next.boundingBox() };
          await page.screenshot({ path: path.join(evidence, `${label}-read.png`) });
          assert.ok(
            Math.abs(after.next.y - before.next.y) <= 1,
            `next target moved ${after.next.y - before.next.y}px after read`,
          );
          // Click the previous physical position: the following thread must receive it.
          await page.mouse.click(before.next.x + 80, before.next.y + 12);
          assert.equal(new URL(page.url()).pathname, `/thread/${nextId}`);
          await page.mouse.move(500, 500);
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          if (!deep) {
            const wrapper = green.locator('xpath=ancestor::*[@data-sidebar-row-key][1]');
            assert.ok(
              (await wrapper.boundingBox()).height < before.green.height,
              'released reading space compacts to live facts',
            );
          }
          if (count === 260) assert.equal(await page.getByTestId('virtual-attention-list').count(), 1);
        } finally {
          writeFileSync(
            path.join(evidence, `${label}-measurement.json`),
            JSON.stringify({ before, after, requests: api.requests }, null, 2),
          );
          await harness.closeProof(proof);
          await context.close();
        }
      },
    );
}

// One real Next route transition protects the seam that the component fixture's
// navigation boundary cannot cover. API/provider responses remain isolated.
export async function runNativeSidebarReadingJourney(browser) {
  const evidence = process.env.F322_SIDEBAR_READING_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-sidebar-reading');
  mkdirSync(evidence, { recursive: true });
  const host = await startNativeHost();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const api = createChatProofApi(Date.now(), false, false);
  const errors = [];
  const greenId = 'composer-proof-2';
  let before, after;
  api.preferences.groups = [];
  api.threads.forEach((row, index) => {
    row.title = `Native sidebar ${index}`;
    row.unreadCount = index === 2 ? 1 : 0;
    row.hasUserMention = false;
    row.presence = index === 2 ? { status: 'done', cats: ['codex61-sol'] } : { status: 'idle' };
  });
  for (let index = 11; index < 260; index++)
    api.threads.push({
      ...api.threads[3],
      id: `native-${index}`,
      title: `History ${index}`,
      lastActiveAt: 1,
    });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.ready();
    await page.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:sidebar:active-tab', 'pinned');
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, host.url, 'native API cannot reach runtime');
      if (url.pathname === `/api/threads/${greenId}/read/latest`) {
        api.threads[2].unreadCount = 0;
        api.threads[2].presence = { status: 'idle' };
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ advanced: true, caughtUp: true }),
        });
      }
      const own = api.respond(request, url);
      if (own) return route.fulfill(own);
      const fixture = realSurfaceApiResponse(request, false);
      return route.fulfill({
        status: fixture?.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture?.body ?? {}),
      });
    });
    await page.goto(`${host.url}/thread/composer-proof-0`);
    const sidebar = page.getByTestId('sidebar-thread-list');
    const green = sidebar.locator(`[data-thread-id="${greenId}"]`);
    await green.getByTestId('thread-row-done').waitFor();
    await green.locator('[role="link"]').hover();
    const next = sidebar.locator('[data-thread-id="composer-proof-0"]');
    before = await next.boundingBox();
    await page.screenshot({ path: path.join(evidence, 'native-before.png') });
    await green.locator('[role="link"]').click();
    await page.waitForURL(`${host.url}/thread/${greenId}`);
    await green.getByTestId('thread-row-done').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(evidence, 'native-read.png') });
    after = await next.boundingBox();
    assert.ok(Math.abs(after.y - before.y) <= 1, `native Next click moved the following row ${after.y - before.y}px`);
    await page.mouse.click(before.x + 80, before.y + 12);
    await page.waitForURL(`${host.url}/thread/composer-proof-0`);
    assert.deepEqual(errors, []);
  } finally {
    writeFileSync(
      path.join(evidence, 'native-measurement.json'),
      JSON.stringify({ url: host.url, before, after, errors, requests: api.requests }, null, 2),
    );
    await context.close();
    await host.close();
  }
}
