import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import {
  captureComposerDraftFailure,
  closeComposerWorkspaceOwner,
  observeComposerDraftExit,
  routeComposerDraft,
  startComposerWorkspaceOwner,
} from './f309-composer-workspace-owner.mjs';
import { registerFileQuotePersistenceJourneys } from './f309-file-quote-persistence.mjs';
import { assertThemeApplied, EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { routeThroughRealOwner } from './f309-ordinary-workspace-real-owner.mjs';
import { registerPendingFileQuoteEditJourneys } from './f309-pending-file-quote-edit.mjs';

const FILE_NAME = 'f309-text-quote-journey.md';
const FILE_PATH = `packages/web/test/browser/fixtures/${FILE_NAME}`;
// Crosses bold → soft line break → paragraph → emphasis: the rendered shape the retired composer lost (red banner).
const FROM = '暮色里的灯塔';
const TO = 'salt on the window';
const COMMENT = ['这里的灯塔意象要保留 · keep the lighthouse', '第二行：换一个动词 / change the verb'];

/** The model-facing text the cat receives, through the API's own send schema and routing projection. */
export async function modelProjection(body) {
  const { sendMessageSchema, buildMessageContentBlocks } = await import('../../../api/dist/routes/messages.schema.js');
  const { appendContextAttachmentsToPrompt } = await import(
    '../../../api/dist/domains/cats/services/agents/routing/context-attachment-prompt.js'
  );
  const input = sendMessageSchema.parse(body);
  return appendContextAttachmentsToPrompt(
    input.content,
    buildMessageContentBlocks(input.content, input.contextAttachments),
  );
}

async function selectRendered(page, from, to) {
  await page.evaluate(
    ([start, end]) => {
      const root = document.querySelector('[data-testid="workspace-content-review-text"]');
      if (!root) throw new Error('text surface is missing');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let anchor = null;
      let focus = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (!anchor && text.includes(start)) anchor = [node, text.indexOf(start)];
        if (text.includes(end)) focus = [node, text.indexOf(end) + end.length];
      }
      if (!anchor || !focus) throw new Error(`not rendered: ${start} … ${end}`);
      const range = document.createRange();
      range.setStart(anchor[0], anchor[1]);
      range.setEnd(focus[0], focus[1]);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    [from, to],
  );
}

// CVO095/098 (Astra plan §3): a text selection goes through the one existing chain — in-place card →
// chat annotation chip → explicit send — never a second F309 text annotation.
export function registerOrdinaryTextQuoteJourney(suite) {
  async function openFromHome({ viewport, prefix, run, draft, dark = false }) {
    const evidence = await mkdtemp(`/tmp/${prefix}-`);
    const owner = await startComposerWorkspaceOwner(path.join(evidence, 'data'));
    const context = await suite().browser.newContext({ viewport });
    if (dark) await context.addInitScript(() => window.localStorage.setItem('theme', 'dark'));
    const errors = [];
    const posts = [];
    const sent = [];
    const browserDraftEvents = await observeComposerDraftExit(context);
    try {
      await routeThroughRealOwner(context, owner, {
        extra: async (route, url) => {
          if (await routeComposerDraft(route, url, owner)) return true;
          if (url.pathname !== '/api/messages' || route.request().method() !== 'POST') return false;
          sent.push(route.request().postDataJSON());
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ userMessageId: 'file-quote-send-receipt' }),
          });
          return true;
        },
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      });
      await page.goto(suite().baseUrl, { waitUntil: 'domcontentloaded' });
      if (dark) {
        await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
        await assertThemeApplied(page, true);
      }
      if (draft) {
        // SSR already has the thread attribute; wait for the client handlers before typing into that owner.
        await page.waitForLoadState('networkidle');
        await page
          .locator(`[data-thread-chat-surface][data-thread-id="${THREAD_ID}"]`)
          .getByLabel('消息输入框')
          .fill(draft);
        await page.waitForFunction(
          ([threadId, expected]) => {
            const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts') ?? '[]');
            return drafts.some(([id, text]) => id === threadId && text === expected);
          },
          [THREAD_ID, draft],
        );
      }
      await ensureWorkspaceOpen(page);
      const home = page.getByTestId('workspace-launcher-home');
      await home.getByTestId('workspace-launcher-search').fill(FILE_NAME);
      await home
        .getByTestId('workspace-launcher-file-result')
        .filter({ has: page.getByText(FILE_NAME, { exact: true }) })
        .first()
        .click();
      const surface = page.getByTestId('workspace-content-review-surface');
      await surface.getByText(TO, { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(await surface.locator(`[data-owner-path="${FILE_PATH}"]`).count(), 1);
      await run({ page, surface, errors, posts, sent, evidence, owner, context });
    } catch (error) {
      const page = context.pages()[0];
      await captureComposerDraftFailure({ directory: EVIDENCE, prefix, page, owner, browserDraftEvents, sent, error });
      const body = page
        ? await page
            .locator('body')
            .innerText()
            .catch(() => 'unavailable')
        : 'no page';
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nerrors: ${errors}\nposts: ${posts}\nbody: ${body}`,
        { cause: error },
      );
    } finally {
      await closeComposerWorkspaceOwner(context, owner);
    }
  }

  async function addToChat(page, posts) {
    const before = posts.length;
    await selectRendered(page, FROM, TO);
    await page.getByTestId('workspace-content-review-text-add-to-chat').click();
    const editor = page.getByTestId('context-annotation-comment');
    await editor.waitFor();
    await editor.fill(COMMENT[0]);
    await editor.press('Shift+Enter');
    await editor.pressSequentially(COMMENT[1]);
    await editor.press('Enter');
    await page.getByTestId('context-annotations-summary').waitFor({ state: 'attached' });
    // Adding is not sending, not a Task and not a new F309 text annotation: nothing is written at all.
    assert.deepEqual(posts.slice(before), []);
    return editor;
  }

  /** One more place of the same file, added to the same draft with its own words. */
  async function addPlace(page, posts, from, to, words) {
    const before = posts.length;
    const addButton = page.getByTestId('workspace-content-review-text-add-to-chat');
    const editor = page.getByTestId('context-annotation-comment');
    // A synthetic selection here was observed, now and then, to produce no add button (the cause was not traced; a
    // second selection of the same words does). A person would select again, so this does too, a bounded number of
    // times: what is asserted afterwards is the state the page ended up in, not that the first try worked.
    for (let attempt = 1; ; attempt += 1) {
      await selectRendered(page, from, to);
      try {
        await addButton.click({ timeout: 4000 });
        await editor.waitFor({ timeout: 4000 });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    await editor.fill(words);
    await editor.press('Enter');
    await page.getByTestId('context-annotations-summary').waitFor({ state: 'attached' });
    assert.deepEqual(posts.slice(before), [], 'adding a place writes nothing');
  }

  registerPendingFileQuoteEditJourneys({
    openFromHome,
    addPlace,
    modelProjection,
    filePath: FILE_PATH,
  });
  registerFileQuotePersistenceJourneys({ openFromHome, addPlace, suite });

  test(
    'text: a rendered selection → card → chat chip → explicit send, as the original chain',
    { timeout: 120_000 },
    async () => {
      await openFromHome({
        viewport: { width: 1280, height: 900 },
        prefix: 'f309-text-quote',
        run: async ({ page, surface, errors, posts, sent }) => {
          assert.equal(await surface.getByText('已选文本', { exact: false }).count(), 0);
          assert.equal(await surface.getByPlaceholder('写下这条批注…').count(), 0);
          await addToChat(page, posts);
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/text-quote-chip.png` });

          // Return to where the file was opened from, then reload: the chip is the chat draft and survives both.
          await surface.getByRole('button', { name: '返回来源', exact: true }).click();
          await page.getByTestId('workspace-launcher-home').waitFor();
          await page.reload({ waitUntil: 'domcontentloaded' });
          const summary = page.getByTestId('context-annotations-summary');
          await summary.waitFor();
          assert.equal(sent.length, 0);
          await summary.click();
          const item = page.locator('[data-testid^="context-annotation-item-"]').first();
          await item.waitFor();
          const shown = await item.innerText();
          assert.ok(shown.includes(FROM) && shown.includes(TO), shown);
          assert.ok(shown.includes(COMMENT[0]) && shown.includes(COMMENT[1]), shown);

          await page.getByRole('button', { name: 'Send message', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="context-annotations-summary"]'));
          assert.equal(sent.length, 1);
          const [quote] = sent[0].contextAttachments;
          assert.equal(quote.kind, 'quote');
          assert.ok(quote.text.startsWith(FROM) && quote.text.endsWith(TO), quote.text);
          assert.ok(quote.text.includes('\n'), 'the quote keeps its line structure');
          assert.equal(quote.comment, COMMENT.join('\n'));
          assert.equal(quote.source.kind, 'workspace_file');
          assert.equal(quote.source.path, FILE_PATH);
          assert.ok(quote.source.worktreeId, 'the quote names its real worktree');
          // The version is the owner's own revision of the very bytes on disk, in the form a cat's takeover compares
          // it in: without it the cat could not take the request over at all (it answers "source changed").
          const onDisk = await readFile(new URL(`./fixtures/${FILE_NAME}`, import.meta.url));
          assert.equal(
            quote.source.revision,
            `sha256:${createHash('sha256').update(onDisk).digest('hex')}`,
            'the quote names the exact version of the file it was selected in',
          );
          assert.equal(quote.source.lineStart, undefined, 'rendered Markdown claims no file lines it does not have');

          const prompt = await modelProjection(sent[0]);
          const projected = JSON.parse(
            prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
          );
          assert.deepEqual(projected, sent[0].contextAttachments);
          assert.ok(!posts.some((post) => post.endsWith('/annotations')), posts.join(', '));
          assert.deepEqual(errors, []);
        },
      });
    },
  );

  test(
    'text: two places in the same file go as one message, each with its own words and the one version they were made in',
    { timeout: 120_000 },
    async () => {
      await openFromHome({
        viewport: { width: 1280, height: 900 },
        prefix: 'f309-text-quote-two',
        run: async ({ page, errors, posts, sent }) => {
          await addPlace(page, posts, '暮色里的灯塔', '暮色里的灯塔', '这一处保留');
          await addPlace(page, posts, 'salt on the window', 'salt on the window', '这一处换个说法');
          const summary = page.getByTestId('context-annotations-summary');
          assert.match((await summary.textContent()) ?? '', /2 annotations/);
          await summary.click();
          const items = page.locator('[data-testid^="context-annotation-item-"]');
          assert.equal(await items.count(), 2, 'both places are in the draft, none replaced the other');
          assert.match((await items.nth(0).innerText()) ?? '', /^第\s*1\s*处[\s\S]*暮色里的灯塔[\s\S]*这一处保留/);
          assert.match(
            (await items.nth(1).innerText()) ?? '',
            /^第\s*2\s*处[\s\S]*salt on the window[\s\S]*这一处换个说法/,
          );
          // Both were made in a version the owner named: nothing here says "cannot confirm where this place is".
          assert.equal(await page.getByText('无法确认当前位置').count(), 0);
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/text-quote-two-places.png` });

          await page.getByRole('button', { name: 'Send message', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="context-annotations-summary"]'));
          assert.equal(sent.length, 1, 'one send');
          const quotes = sent[0].contextAttachments;
          assert.equal(quotes.length, 2);
          assert.deepEqual(
            quotes.map((quote) => quote.comment),
            ['这一处保留', '这一处换个说法'],
            'the order the person made them in',
          );
          assert.equal(new Set(quotes.map((quote) => quote.id)).size, 2, 'each place has its own id');
          const onDisk = await readFile(new URL(`./fixtures/${FILE_NAME}`, import.meta.url));
          const revision = `sha256:${createHash('sha256').update(onDisk).digest('hex')}`;
          assert.deepEqual(
            quotes.map((quote) => [quote.source.path, quote.source.revision]),
            [
              [FILE_PATH, revision],
              [FILE_PATH, revision],
            ],
            'the same file, the same version',
          );
          assert.deepEqual(errors, []);
        },
      });
    },
  );

  test(
    'text: at 390px the card opens inside the screen and still only adds the chip',
    { timeout: 120_000 },
    async () => {
      await openFromHome({
        viewport: { width: 390, height: 844 },
        prefix: 'f309-text-quote-390',
        run: async ({ page, posts, errors }) => {
          await selectRendered(page, FROM, TO);
          await page.getByTestId('workspace-content-review-text-add-to-chat').click();
          const card = page.getByTestId('context-annotation-editor');
          await card.waitFor();
          const box = await card.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0, JSON.stringify(box));
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/text-quote-390-card.png` });
          const before = posts.length;
          await page.getByTestId('context-annotation-comment').fill('390 宽也能写 · narrow');
          await page.getByTestId('context-annotation-comment').press('Enter');
          await page.getByTestId('context-annotations-summary').waitFor({ state: 'attached' });
          assert.deepEqual(posts.slice(before), []);
          assert.deepEqual(errors, []);
        },
      });
    },
  );
}
