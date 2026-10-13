import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collapseV2Workspace } from './f307-workspace-open.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

/** Real Next/Chat/Workspace controls; intercepted sends are verified through the API schema and prompt projection. */
export function registerWholeImageChatJourney(openWork) {
  for (const [slug, width, dark] of [
    ['desktop-light', 1440, false],
    ['390-dark', 390, true],
  ]) {
    test(
      `image Chat primary: whole work preserves the draft and leaves through one send ${slug}`,
      { timeout: 120_000 },
      async () => {
        const { context, page, errors, sent } = await openWork({ width, dark, shell: 'v2' });
        try {
          const composer = page.getByLabel('消息输入框');
          await composer.fill('原聊天里的整图修改想法');
          const whole = page.getByTestId('workspace-media-chat-whole-work');
          await whole.waitFor({ timeout: 15_000 });
          assert.equal(await page.getByTestId('content-modification-entry').count(), 0);
          await whole.click();
          const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
          await chip.waitFor();
          assert.equal(await composer.inputValue(), '原聊天里的整图修改想法');
          assert.equal(sent.length, 0, 'adding a whole work cannot send or write a review');
          await whole.click();
          assert.equal(await chip.count(), 1, 'reopening the same whole work keeps one reference');
          assert.equal(await page.getByLabel('消息输入框').count(), 1, 'one chat input remains the only sender');
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-${slug}.png` });
          if (width === 390) {
            await collapseV2Workspace(page);
            assert.equal(await composer.inputValue(), '原聊天里的整图修改想法');
            assert.equal(await chip.count(), 1, 'the single-column return keeps the same chat draft');
            await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-return-${slug}.png` });
          }
          await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
          assert.equal(sent.length, 1);
          const [body] = sent;
          assert.equal(body.content, '原聊天里的整图修改想法');
          assert.equal(body.contextAttachments.length, 1);
          const [media] = body.contextAttachments;
          assert.equal(media.kind, 'media');
          assert.equal(media.mediaType, 'image/png');
          assert.equal(media.source.locator.path, 'art/cover.png');
          assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
          assert.equal(media.source.reviewId, REVIEW_ID);
          assert.deepEqual(media.selections, []);
          const prompt = await modelProjection(body);
          const projected = JSON.parse(
            prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
          );
          assert.deepEqual(projected, body.contextAttachments);
          await writeFile(
            `${EVIDENCE}/image-chat-primary-payload-${slug}.json`,
            `${JSON.stringify({ scope: 'intercepted UI send validated by own API schema and prompt projection', body }, null, 2)}\n`,
          );
          await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-sent-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'image Chat primary: composed text and the exact whole work survive return and reload before one send',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors, sent } = await openWork({ shell: 'v2' });
      try {
        const composer = page.getByLabel('消息输入框');
        const words = '整图改为薄荷绿\nkeep the gold star';
        await composer.fill('整图改为薄荷绿');
        await composer.press('Shift+Enter');
        await composer.pressSequentially('keep the gold star');
        assert.equal(await composer.inputValue(), words);
        await page.getByTestId('workspace-media-chat-whole-work').click();
        const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
        await chip.waitFor();
        await composer.dispatchEvent('compositionstart', { data: '绿' });
        await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
        assert.equal(sent.length, 0, 'IME confirmation cannot send the whole-image request');
        assert.equal(await composer.inputValue(), words);
        await composer.dispatchEvent('compositionend', { data: '绿' });
        await collapseV2Workspace(page);
        await page.waitForFunction(
          ([threadId, expected]) => {
            const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts') ?? '[]');
            const media = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
            return (
              drafts.some(([id, text]) => id === threadId && text === expected) &&
              media.some(([id, items]) => id === threadId && items.length === 1 && items[0].kind === 'media')
            );
          },
          [THREAD_ID, words],
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await chip.waitFor();
        assert.equal(await composer.inputValue(), words);
        assert.equal(sent.length, 0, 'restoring a draft cannot send');
        assert.equal(await chip.count(), 1);
        await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
        assert.equal(sent.length, 1);
        const [body] = sent;
        assert.equal(body.content, words);
        assert.equal(body.contextAttachments.length, 1);
        const [media] = body.contextAttachments;
        assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
        assert.equal(media.source.reviewId, REVIEW_ID);
        assert.equal(media.source.locator.path, 'art/cover.png');
        assert.deepEqual(media.selections, []);
        const prompt = await modelProjection(body);
        assert.deepEqual(
          JSON.parse(prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<'))),
          body.contextAttachments,
        );
        await writeFile(
          `${EVIDENCE}/image-chat-primary-restored-payload.json`,
          `${JSON.stringify({ words, body }, null, 2)}\n`,
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
}
