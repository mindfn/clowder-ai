import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

export function registerReadingWheelJourneys(context) {
  for (const mode of ['offset', 'near-bottom']) {
    test(`trusted ${mode} upward wheels keep their pixels across passive commits`, async () => {
      const page = await context.browser().newPage({ viewport: { width: 1000, height: 900 } });
      const errors = [];
      const observations = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.__readingWheelInputs = [];
        document.addEventListener('wheel', (event) => {
          window.__readingWheelInputs.push({ trusted: event.isTrusted, deltaY: event.deltaY });
        });
      });
      const records = Array.from({ length: 80 }, (_, index) => ({
        id: `scroll-${index + 1}`,
        from: { kind: 'agent', catId: 'codex-astra' },
        catId: 'codex-astra',
        type: 'assistant',
        content: `Reading message ${index + 1}`,
        timestamp: index + 1,
      }));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, context.origin);
        assert.equal(route.request().method(), 'GET');
        if (url.pathname === '/proof.js') {
          return route.fulfill({ contentType: 'text/javascript', body: context.bundle() });
        }
        if (url.pathname.startsWith('/api/')) {
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(
              url.pathname === '/api/messages'
                ? { messages: records, hasMore: false }
                : { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] },
            ),
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><style>[data-message-viewport-boundary]{display:flow-root;content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
        });
      });
      const evidenceDir = process.env.CHAT_SCROLL_EVIDENCE_DIR;
      if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
      try {
        await page.goto(`${context.origin}/${context.threadId}?scroll=1&revalidateAtScroll=1`);
        await page.locator('[data-message-id="scroll-80"]').waitFor();
        await page.waitForTimeout(750);
        const viewport = page.locator('[data-scroll-chat]');
        await viewport.hover();
        if (mode === 'offset') {
          await page.mouse.wheel(0, -400);
          await page.waitForTimeout(350);
        }
        const markerId = await viewport.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest('[data-message-viewport-id]')
            ?.getAttribute('data-message-viewport-id');
        });
        assert.ok(markerId, 'a real visible message is the reading coordinate');
        const sample = () =>
          viewport.evaluate(
            (el, id) => ({
              top: el.scrollTop,
              height: el.scrollHeight,
              markerId: id,
              markerTop: el.querySelector(`[data-message-viewport-id="${id}"]`).getBoundingClientRect().top,
              revalidations: Number(el.dataset.revalidationCount ?? 0),
            }),
            markerId,
          );
        const before = await sample();
        observations.push(before);
        const delta = mode === 'offset' ? -32 : -2;
        for (let index = 0; index < 4; index += 1) {
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(350);
          const after = await sample();
          observations.push(after);
          const previous = observations.at(-2);
          assert.ok(after.revalidations > previous.revalidations, 'the real store committed before React scroll');
          // Offscreen content-visibility estimates can shrink while scrolling.
          // The visible message must move by the wheel delta after compensation.
          assert.ok(
            Math.abs(after.markerTop - previous.markerTop + delta) <= 0.5,
            'every upward gesture moves the visible reading message by its native delta',
          );
        }
        await page.getByRole('button', { name: 'Passive update', exact: true }).click();
        await page.waitForTimeout(350);
        const passive = await sample();
        assert.equal(
          passive.markerTop,
          observations.at(-1).markerTop,
          'a later update does not reclaim the visible reading position',
        );
        observations.push(passive);
        const inputs = await page.evaluate(() => window.__readingWheelInputs);
        assert.ok(inputs.length >= 4 && inputs.every((input) => input.trusted && input.deltaY < 0));
        assert.deepEqual(errors, []);
      } finally {
        if (evidenceDir) {
          await page.screenshot({ path: path.join(evidenceDir, `${mode}-wheel.png`) });
          writeFileSync(path.join(evidenceDir, `${mode}-wheel.json`), JSON.stringify({ observations, errors }));
        }
        await page.close();
      }
    });
  }
}
