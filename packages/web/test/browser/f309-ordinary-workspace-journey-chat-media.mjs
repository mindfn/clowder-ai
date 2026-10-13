import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { registerWholeImageChatJourney } from './f309-image-chat-primary.mjs';
import {
  assertFitsViewport,
  assertReadable,
  EVIDENCE,
  measureContrast,
  openChatPage,
} from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

// Real Next shell, production CSS, the real composer and the real artwork surface; the network is the journey
// fixture and the send is intercepted (nothing reaches a cat). The sent body is then run through the API's own send
// schema and prompt projection, so what is proven is what a cat would be handed for the places the person circled,
// not that a cat acted on them.
const TEXT_MIN_CONTRAST = 4.5;
const CHIP = '[data-testid="context-attachment-list"] [data-context-kind="media"]';
const MARKS = '[data-testid="review-pending-chat-mark"]';

const SEEDED = (id) => ({
  v: 1,
  id,
  kind: 'media',
  title: '窄屏设计稿.png',
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'wt-seeded', path: 'art/cover.png' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'review-seeded',
    expectedReviewRevision: 1,
  },
  selections: [
    {
      id: '1',
      selection: { kind: 'image-region', x: 411, y: 622, width: 733, height: 144 },
      instruction: '移除这里的字，其余保持不变',
    },
    { id: '2', selection: { kind: 'image-point', x: 987, y: 654 } },
  ],
});

// A sent image message whose request a cat took over. The owner's answers are a fixture: this proves how the line
// is joined, looks and behaves under the message, not that a real cat is working.
const REQUEST_ID = `f309-modification-${'e'.repeat(64)}`;
const DECOY_ID = `f309-modification-${'f'.repeat(64)}`;
const SENT_ID = 'human-media-sent';
const sentMessage = (timestamp = 1) => ({
  id: SENT_ID,
  type: 'user',
  content: '这两处帮我处理一下',
  timestamp,
  contentBlocks: [
    { type: 'text', text: '这两处帮我处理一下' },
    { type: 'context_attachment', attachment: SEEDED('media-sent') },
  ],
});
const requestRecord = (requestId, messageId, sourceKind = 'human_message') => ({
  requestId,
  ownerUserId: 'operator',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  progress: { sourceMessageId: messageId, sourceKind },
  payload: { targetCatId: 'codex-sol', threadId: 'execution-thread' },
});
function requestDetail({ revision = 1, execution, cancelled = false } = {}) {
  return {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: execution
      ? { state: execution, messageId: 'carrier', targetCatId: 'codex-sol', observedAt: 1, evidenceRef: 'evidence' }
      : undefined,
    record: {
      ...requestRecord(REQUEST_ID, SENT_ID),
      revision,
      control: cancelled
        ? {
            state: 'cancelled',
            actorId: 'operator',
            cancelledAt: 1,
            receiptRef: 'receipt',
            taskResolution: 'preserved',
          }
        : undefined,
    },
  };
}
/**
 * The owner as the chat reads it: the context catalogue (one request that really came from this message, one that
 * came from another message) and the request itself. Every call is recorded for the assertions.
 */
function ownerApi({ taken = () => true, respond }) {
  return async (request, url, calls) => {
    if (url.pathname === '/api/content-modifications/context' && request.method() === 'POST') {
      calls.push(`context ${JSON.stringify(request.postDataJSON().source)}`);
      return {
        body: {
          requests: taken()
            ? [
                { record: requestRecord(REQUEST_ID, SENT_ID), stage: 'queued' },
                { record: requestRecord(DECOY_ID, 'human-other-message'), stage: 'queued' },
              ]
            : [{ record: requestRecord(DECOY_ID, 'human-other-message'), stage: 'queued' }],
          contexts: [{ requestIds: [REQUEST_ID], targetName: '烁烁' }],
        },
      };
    }
    if (url.pathname.startsWith(`/api/content-modifications/${DECOY_ID}`)) {
      calls.push(`DECOY ${request.method()}`);
      return { body: { error: 'not_found' }, status: 404 };
    }
    if (url.pathname.startsWith(`/api/content-modifications/${REQUEST_ID}`)) {
      calls.push(`${request.method()} ${url.pathname.slice(`/api/content-modifications/${REQUEST_ID}`.length)}`);
      return respond(request.method(), url.pathname);
    }
    return undefined;
  };
}

async function assertFits(page, locator, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal overflow, got ${overflow}px`);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    box && box.x >= 0 && box.x + box.width <= viewport.width + 1,
    `${label}: inside the window ${JSON.stringify(box)}`,
  );
}

/** Every word of the attachment (title, detail, number, label, instruction) is legible where it really sits. */
async function assertLegible(root, label, measured) {
  const spans = root.locator('span');
  let seen = 0;
  for (let index = 0; index < (await spans.count()); index += 1) {
    const item = spans.nth(index);
    const text = ((await item.textContent()) ?? '').trim();
    if (!text || (await item.locator('span').count()) > 0) continue;
    const ratio = await measureContrast(item, 'text');
    measured[`${label} | ${text}`] = Number(ratio.toFixed(2));
    assert.ok(ratio >= TEXT_MIN_CONTRAST, `${label}: "${text}" is ${ratio.toFixed(2)}:1, below ${TEXT_MIN_CONTRAST}:1`);
    seen += 1;
  }
  assert.ok(seen >= 4, `${label}: measured ${seen} words, expected the title, detail and each place`);
}

export function registerOrdinaryChatMediaJourney(suite) {
  async function openWork({ shell, ...options } = {}) {
    const sent = [];
    const chosenSuite = shell ? () => ({ ...suite(), baseUrl: `${suite().baseUrl}?shell=${shell}` }) : suite;
    const opened = await openChatPage(chosenSuite, {
      ...options,
      messages: [],
      handleApi: async (request, url) => {
        if (url.pathname === '/api/messages' && request.method() === 'POST') {
          sent.push(request.postDataJSON());
          return { body: {} };
        }
        return undefined;
      },
    });
    const { page } = opened;
    const home = await openWorkspaceTools(page);
    await home.getByTestId('workspace-launcher-search').fill('cover');
    await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
    await page.getByTestId('workspace-content-review-media').waitFor({ timeout: 30_000 });
    return { ...opened, sent };
  }
  registerWholeImageChatJourney(openWork);

  const addPlace = async (page, words) => {
    if (words) await page.getByPlaceholder('写下这条批注…').fill(words);
    await page.getByTestId('workspace-content-review-media-add-to-chat').click();
  };
  const numbers = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));

  test(
    'image: circled places go into the one chat composer as numbered chips, and leave in one send',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors, sent } = await openWork();
      try {
        // The whole image, with words for that place.
        await page.getByRole('button', { name: '标注整张图片', exact: true }).click();
        const save = page.getByRole('button', { name: '保存批注', exact: true });
        assert.equal(await save.isVisible(), false, 'saving is an explicit editing action, not another primary send');
        const editing = page.getByLabel('批注操作', { exact: true });
        await editing.click();
        assert.equal(await save.isVisible(), true, 'the original save remains reachable');
        await page.screenshot({ path: `${EVIDENCE}/media-chat-annotation-actions-1440.png` });
        await editing.click();
        await addPlace(page, '移除角落的标志');
        const chip = page.locator(CHIP);
        await chip.waitFor({ timeout: 15_000 });
        assert.equal(sent.length, 0, 'adding is not sending');

        // A second place, circled by hand on the picture. After an add the canvas stays ready to circle again
        // ("取消圈选" is showing); only when it is not does the person have to ask for it.
        const startCircling = page.getByRole('button', { name: '圈选区域', exact: true });
        if ((await startCircling.count()) > 0) await startCircling.click();
        await page.getByRole('button', { name: '取消圈选', exact: true }).waitFor();
        const box = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
        await page.mouse.up();
        await addPlace(page);

        // One chip, two numbered places in the order they were added, and the same numbers on the picture.
        assert.equal(await page.locator(CHIP).count(), 1, 'one media attachment for one work');
        const tags = page.locator(`${CHIP} [data-selection-id]`);
        assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1', '2']);
        assert.equal(await tags.first().getAttribute('title'), '移除角落的标志');
        assert.deepEqual(await numbers(page.locator(`${MARKS} text`)), ['1', '2']);
        await page.screenshot({ path: `${EVIDENCE}/media-chat-composer-1440.png` });

        // Taking the first place away renumbers what the person sees, never what is sent: the survivor keeps id "2".
        await page.getByRole('button', { name: '移除选区 1', exact: true }).click();
        await page.waitForFunction(
          (selector) => document.querySelectorAll(selector).length === 1,
          `${CHIP} [data-selection-id]`,
        );
        assert.equal(await page.locator(`${CHIP} [data-selection-id]`).getAttribute('data-selection-id'), '2');
        assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1']);
        assert.deepEqual(await numbers(page.locator(`${MARKS} text`)), ['1']);
        assert.equal(await page.locator(MARKS).getAttribute('data-selection-id'), '2');

        await page.getByLabel('消息输入框').fill('请处理这一处');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
        assert.equal(sent.length, 1);
        assert.equal(await page.locator(MARKS).count(), 0, 'the marks go with the chip');

        const [body] = sent;
        assert.equal(body.content, '请处理这一处');
        assert.equal(body.contextAttachments.length, 1);
        const [media] = body.contextAttachments;
        assert.equal(media.kind, 'media');
        assert.equal(media.mediaType, 'image/png');
        assert.equal(media.source.kind, 'workspace');
        assert.equal(media.source.locator.path, 'art/cover.png');
        assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
        assert.equal(media.source.reviewId, REVIEW_ID);
        assert.equal(media.selections.length, 1);
        assert.equal(media.selections[0].id, '2', 'stable id: not renumbered after the first place was removed');
        assert.equal(media.selections[0].selection.kind, 'image-region');
        assert.ok(!('instruction' in media.selections[0]), 'the removed place took its words with it');
        // The real send schema and prompt projection hand the cat exactly what was sent.
        const prompt = await modelProjection(body);
        const projected = JSON.parse(
          prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
        );
        assert.deepEqual(projected, body.contextAttachments);

        // The sent message reads as the places that were circled, with no coordinates and no internal ids.
        const sentChip = page.locator('[data-chat-container] [data-context-kind="media"]');
        await sentChip.waitFor();
        const shown = (await sentChip.textContent()) ?? '';
        assert.ok(shown.includes('图片 · 1处选区') && shown.includes('圈选'), shown);
        assert.doesNotMatch(
          await page.locator('[data-chat-container]').innerText(),
          /image-region|sha256|review-|expectedSource/,
        );
        await page.screenshot({ path: `${EVIDENCE}/media-chat-sent-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  const measured = {};
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `image: the places read legibly in the composer chip and in the sent message (${label})`,
      { timeout: 90_000 },
      async () => {
        const slug = label.replaceAll(' ', '-');
        const message = {
          id: 'human-media',
          type: 'user',
          content: '这两处帮我处理一下',
          timestamp: 1,
          contentBlocks: [
            { type: 'text', text: '这两处帮我处理一下' },
            { type: 'context_attachment', attachment: SEEDED('media-sent') },
          ],
        };
        const { context, page, errors } = await openChatPage(suite, {
          width,
          dark,
          messages: [message],
          sessionStorage: {
            'cat-cafe:thread-context-attachment-drafts': JSON.stringify([[THREAD_ID, [SEEDED('media-draft')]]]),
          },
        });
        try {
          const chip = page.locator(CHIP);
          await chip.waitFor({ timeout: 20_000 });
          const sentChip = page.locator('[data-message-id="human-media"] [data-context-kind="media"]');
          await sentChip.waitFor();
          assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1', '2']);
          assert.deepEqual(await numbers(sentChip.locator('[data-testid="media-selection-number"]')), ['1', '2']);
          // Where the person can still take a place away, and where they cannot.
          assert.equal(await chip.getByRole('button', { name: '移除选区 1', exact: true }).count(), 1);
          assert.equal(await sentChip.getByRole('button').count(), 0);
          assert.ok(((await sentChip.textContent()) ?? '').includes('移除这里的字，其余保持不变'));
          assert.doesNotMatch(
            `${await chip.textContent()}${await sentChip.textContent()}`,
            /411|622|733|144|987|654|image-region|image-point|sha256|review-seeded/,
          );
          await assertFits(page, chip, `${label} composer chip`);
          await assertFits(page, sentChip, `${label} sent attachment`);
          await assertLegible(chip, `${label} composer chip`, measured);
          await assertLegible(sentChip, `${label} sent attachment`, measured);
          await writeFile(`${EVIDENCE}/contrast-media-chat.json`, `${JSON.stringify(measured, null, 2)}\n`);
          await page.screenshot({ path: `${EVIDENCE}/media-chat-chips-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  const requestContrast = { values: {}, file: `${EVIDENCE}/contrast-media-request.json` };
  const bubbleOf = (page) => page.locator(`[data-message-id="${SENT_ID}"]`);
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `image message: the request a cat took over shows live progress under it and cancels in place (${label})`,
      { timeout: 90_000 },
      async () => {
        let cancelled = false;
        const { context, page, calls, errors } = await openChatPage(suite, {
          width,
          dark,
          messages: [sentMessage()],
          handleApi: ownerApi({
            respond: (method, path) => {
              if (method === 'POST' && path.endsWith('/cancel')) {
                cancelled = true;
                return { body: requestDetail({ revision: 2, execution: 'running', cancelled: true }) };
              }
              return { body: requestDetail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }) };
            },
          }),
        });
        const slug = label.replaceAll(' ', '-');
        try {
          const bubble = bubbleOf(page);
          const row = bubble.getByTestId('modification-progress');
          await row.waitFor({ timeout: 20_000 });
          // Only the request that really came from this message: the other message's request is never read.
          assert.equal(await page.getByTestId('modification-progress').count(), 1);
          assert.ok(!calls.some((call) => call.startsWith('DECOY')), `the other message's request was read: ${calls}`);
          const asked = calls.find((call) => call.startsWith('context '));
          assert.ok(asked, `the owner was asked about the work: ${calls}`);
          assert.deepEqual(JSON.parse(asked.slice('context '.length)), SEEDED('x').source);
          assert.equal(await row.getAttribute('data-state'), 'working');
          assert.match(await row.locator('output').textContent(), /修改中 · 窄屏设计稿\.png 2\u00A0处/);
          // The person's own message stays theirs: nothing was written onto it.
          assert.equal(await bubble.getByTestId('content-modification-source').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} working`, requestContrast);
          const cancel = row.getByRole('button', { name: '取消修改' });
          assert.equal(await cancel.textContent(), '取消');
          await bubble.screenshot({ path: `${EVIDENCE}/media-request-working-${slug}.png` });

          await cancel.click();
          await bubble.locator('[data-testid="modification-progress"][data-state="cancelled_still_running"]').waitFor();
          assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'cancel is sent exactly once');
          assert.match(await row.textContent(), /修改已取消，执行仍在进行/);
          assert.match(await row.textContent(), /取消修改不会停止本轮执行。/);
          // No stop control is drawn until a stop handler exists.
          assert.equal(await row.getByRole('button').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} cancelled-still-running`, requestContrast);
          await bubble.screenshot({ path: `${EVIDENCE}/media-request-cancelled-${slug}.png` });
          if (width === 1440 && !dark) await page.screenshot({ path: `${EVIDENCE}/media-request-host-1440.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'image message: a takeover whose event was missed is found by the bounded look while the page is open, then the look stops',
    { timeout: 90_000 },
    async () => {
      let taken = false;
      const { context, page, calls, errors } = await openChatPage(suite, {
        messages: [sentMessage(Date.now())],
        handleApi: ownerApi({ taken: () => taken, respond: () => ({ body: requestDetail({ execution: 'running' }) }) }),
      });
      const until = async (condition, what, ms = 25_000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 200)))
          if (condition()) return;
        assert.fail(`timed out waiting for ${what}`);
      };
      try {
        const bubble = bubbleOf(page);
        await bubble.waitFor({ timeout: 20_000 });
        await until(() => calls.some((call) => call.startsWith('context ')), 'the first read of the owner');
        // Nothing is true to say yet, so nothing is drawn.
        assert.equal(await bubble.getByTestId('modification-progress').count(), 0);
        taken = true;
        await bubble.getByTestId('modification-progress').waitFor({ timeout: 25_000 });
        assert.equal(await bubble.getByTestId('modification-progress').getAttribute('data-state'), 'working');
        // The owner holds one request per message: once it is found nothing more is discovered, and the request's own
        // line keeps reading its own state. (This scene has no socket, so it exercises the fallback, not the event.)
        const contextReads = () => calls.filter((call) => call.startsWith('context ')).length;
        const reads = contextReads();
        await new Promise((done) => setTimeout(done, 9_000));
        assert.equal(contextReads(), reads, 'the look for a takeover stops once the request is found');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
}
