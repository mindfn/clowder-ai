import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxPersonMemoryFixture } from './f322-inbox-person-memory.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-person-memory');
async function freeze(page, target, file) {
  await target.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: file, fullPage: true });
}
async function postThrough(page, record, verb, responses, press) {
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/person-memory-proposals/${record.proposalId}/${verb}` &&
      r.request().method() === 'POST',
  );
  await press();
  const response = await pending,
    body = await response.json();
  responses.push({
    entrance: record.entrance,
    proposalId: record.proposalId,
    verb,
    status: response.status(),
    request: response.request().postDataJSON(),
    body,
  });
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}
async function enabled(button) {
  await button.waitFor();
  await button.page().waitForFunction((element) => !element.disabled, await button.elementHandle());
}
async function approve(page, card, record, responses) {
  const button = card.getByTestId('person-memory-approve-selected');
  await enabled(button);
  return postThrough(page, record, 'approve', responses, async () => {
    await button.focus();
    await page.keyboard.press('Enter');
  });
}
async function reject(page, card, record, responses) {
  const button = card.getByTestId('person-memory-reject');
  await enabled(button);
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[value="other"]').check();
  await dialog.getByTestId('feedback-other-detail').fill('This evidence is not what I said.');
  return postThrough(page, record, 'reject', responses, () => dialog.getByTestId('feedback-submit').click());
}
for (const language of ['zh', 'en'])
  for (const width of [1440, 390]) {
    test(`F322 original person memory Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, 'person-memory', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const fixture = await createInboxPersonMemoryFixture(language),
        source = fixture.approvalSources;
      const chatRecords = source.records.filter((r) => r.entrance === 'Chat'),
        inboxRecords = source.records.filter((r) => r.entrance === 'Inbox');
      let environment, server, browser, page;
      const responses = [],
        errors = [];
      t.after(async () => {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
            await writeFile(
              path.join(evidence, 'final-state.json'),
              JSON.stringify(
                {
                  text: await page.locator('body').innerText(),
                  responses,
                  errors,
                  mutations: fixture.mutations,
                  reads: fixture.reads,
                  effects: await source.effects(),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          const cleanup = await Promise.allSettled([
            browser?.close(),
            (async () => {
              // Next must stop writing before its owned build directory is removed.
              if (server) await stopChild(server);
              await environment?.cleanup();
            })(),
            fixture.close(),
          ]);
          const failed = cleanup.filter((r) => r.status === 'rejected');
          if (failed.length)
            throw new AggregateError(
              failed.map((r) => r.reason),
              'Owned person memory cleanup failed',
            );
        }
      });
      const port = await availablePort();
      environment = await createNextDevTestEnvironment(`f322-person-memory-${language}-${width}`, {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
        FRONTEND_PORT: String(port),
      });
      server = spawn(
        process.execPath,
        [
          path.join(web, 'scripts/sync-vendor-assets.mjs'),
          '--watch',
          '--',
          process.execPath,
          path.join(tree, 'node_modules/next/dist/bin/next'),
          'dev',
          '-H',
          '127.0.0.1',
          '-p',
          String(port),
        ],
        { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`,
        threadId = chatRecords[0].thread.id;
      await waitForHttp(`${base}/thread/${threadId}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${threadId}?shell=v2`);
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original person memory draft';
      await draft.fill(draftText);
      const selected = chatRecords.find((r) => r.verb === 'approve'),
        rejected = chatRecords.find((r) => r.verb === 'reject');
      const card = page.locator(`[data-rich-block-id="${selected.block.id}"]`);
      await card.getByTestId('person-memory-approve-selected').waitFor();
      assert.equal(await card.locator('input[type="checkbox"]').count(), 2);
      await card
        .getByText(language === 'en' ? 'Original words and evidence' : '原话与证据', { exact: true })
        .first()
        .click();
      await freeze(page, card, path.join(evidence, 'Chat-before.png'));
      await card.locator('input[type="checkbox"]').nth(1).uncheck();
      const first = await approve(page, card, selected, responses);
      assert.equal(first.status, 'partially_materialized');
      assert.deepEqual(first.selectedDraftIds, [selected.draftIds[0]]);
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          1,
        selected.block.id,
      );
      const partialEffects = (await source.effects()).find((r) => r.proposalId === selected.proposalId);
      assert.equal(partialEffects.claims.length, 1);
      await freeze(page, card, path.join(evidence, 'Chat-partial.png'));
      await enabled(card.getByTestId('person-memory-undo'));
      const undone = await postThrough(page, selected, 'undo', responses, () =>
        card.getByTestId('person-memory-undo').click(),
      );
      assert.equal(undone.status, 'pending_approval');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          2,
        selected.block.id,
      );
      assert.equal((await source.effects()).find((r) => r.proposalId === selected.proposalId).claims.length, 0);
      await card.locator('input[type="checkbox"]').nth(1).uncheck();
      const repeated = await approve(page, card, selected, responses);
      assert.equal(repeated.status, 'partially_materialized');
      assert.notEqual(repeated.decisionId, first.decisionId);
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          1,
        selected.block.id,
      );
      const complete = await approve(page, card, selected, responses);
      assert.equal(complete.status, 'materialized');
      assert.equal((await source.effects()).find((r) => r.proposalId === selected.proposalId).claims.length, 2);
      await enabled(card.getByTestId('person-memory-undo'));
      assert.match(await card.locator('h3').innerText(), /Lin Chat approve/);
      await freeze(page, card, path.join(evidence, 'Chat-written.png'));
      await postThrough(page, selected, 'undo', responses, () => card.getByTestId('person-memory-undo').click());
      await card
        .getByTestId('person-memory-result')
        .filter({ hasText: language === 'en' ? 'Withdrawn' : '已撤回' })
        .waitFor();
      await reject(page, page.locator(`[data-rich-block-id="${rejected.block.id}"]`), rejected, responses);
      await freeze(
        page,
        page.locator(`[data-rich-block-id="${rejected.block.id}"]`),
        path.join(evidence, 'Chat-rejected.png'),
      );
      await page.getByTestId('mailbox-button').click();
      const panel = page.getByTestId('mailbox-panel');
      for (const record of inboxRecords) {
        const current = panel.getByTestId(`approval-item-${record.proposalId}`);
        await current.getByTestId('person-memory-approve-selected').waitFor();
        assert.equal(await current.locator('input[type="checkbox"]').count(), 2);
        const row = current.locator('xpath=ancestor::li[@data-testid="mailbox-item"]');
        assert.equal(await row.count(), 1);
        assert.equal(await row.locator('[data-testid="mailbox-item-ignore"]').count(), 1);
        const ignoreBox = await row.getByTestId('mailbox-item-ignore').boundingBox(),
          openBox = await row.getByTestId('mailbox-open-original').boundingBox(),
          rowBox = await row.boundingBox();
        assert.ok(ignoreBox && openBox && rowBox);
        assert.ok(Math.abs(ignoreBox.y - openBox.y) <= 1, 'Ignore and Open original must share one footer row');
        assert.ok(openBox.x + openBox.width >= rowBox.x + rowBox.width - 32, 'Original actions stay right aligned');
        await freeze(page, current, path.join(evidence, `Inbox-${record.verb}-before.png`));
        if (record.verb === 'reject') {
          await reject(page, current, record, responses);
          continue;
        }
        const later = await postThrough(page, record, 'not-now', responses, () =>
          current.getByTestId('person-memory-not-now').click(),
        );
        assert.equal(later.status, 'not_now');
        await enabled(current.getByTestId('person-memory-approve-selected'));
        await current.locator('input[type="checkbox"]').nth(1).uncheck();
        const part = await approve(page, current, record, responses);
        assert.equal(part.status, 'partially_materialized');
        await page.waitForFunction(
          (id) =>
            document.querySelector(`[data-testid="approval-item-${id}"]`)?.querySelectorAll('input[type="checkbox"]')
              .length === 1,
          record.proposalId,
        );
        await freeze(page, current, path.join(evidence, 'Inbox-partial.png'));
        const whole = await approve(page, current, record, responses);
        assert.equal(whole.status, 'materialized');
        const result = panel
          .getByTestId('mailbox-retained-result')
          .filter({ has: page.getByTestId('person-memory-undo') });
        await enabled(result.getByTestId('person-memory-undo'));
        assert.match(await result.getByTestId('person-memory-result-subject').innerText(), /Lin Inbox approve/);
        await freeze(page, result, path.join(evidence, 'Inbox-result-with-undo.png'));
        const resultUndo = await postThrough(page, record, 'undo', responses, () =>
          result.getByTestId('person-memory-undo').click(),
        );
        assert.equal(resultUndo.status, 'withdrawn');
        await panel.getByTestId('person-memory-undo-result').waitFor();
        await freeze(page, panel, path.join(evidence, 'Inbox-undone.png'));
      }
      const effects = await source.effects();
      for (const record of source.records) {
        const effect = effects.find((r) => r.proposalId === record.proposalId);
        assert.equal(effect.candidate.state, record.verb === 'approve' ? 'withdrawn' : 'rejected');
        assert.equal(effect.candidateTtl, -1);
        assert.equal(effect.claims.length, record.verb === 'approve' ? 1 : 0);
      }
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      await page.locator(`[data-rich-block-id="${selected.block.id}"]`).getByTestId('person-memory-result').waitFor();
      await page.locator(`[data-rich-block-id="${rejected.block.id}"]`).getByTestId('person-memory-result').waitFor();
      assert.match(
        await page.locator(`[data-rich-block-id="${selected.block.id}"]`).locator('h3').innerText(),
        /Lin Chat approve/,
      );
      await freeze(
        page,
        page.locator(`[data-rich-block-id="${selected.block.id}"]`),
        path.join(evidence, 'Chat-cold-result.png'),
      );
      await page.getByTestId('mailbox-button').click();
      await panel.getByTestId('approval-item-inbox-native-approve').waitFor();
      for (const record of source.records)
        assert.equal(await panel.getByTestId(`approval-item-${record.proposalId}`).count(), 0);
      assert.ok(!fixture.reads.at(-1).items.some((item) => item.approval?.sourceFeatureId === 'F276'));
      assert.deepEqual(errors, []);
      await freeze(page, panel, path.join(evidence, 'Inbox-cold-retired.png'));
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            responses,
            effects,
            reads: fixture.reads,
            mutations: fixture.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Actual Next, original F276 Ingress/adapter/decision routes and Redis Lua store on development6398/db15 with unique owned namespace. Partial selection, exact undo, reapprove after undo, feedback rejection and canonical cold retirement. No runtime/provider or whole17 acceptance.',
          },
          null,
          2,
        ),
      );
    });
  }
