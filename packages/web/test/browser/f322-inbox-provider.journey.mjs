import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProviderHost } from './f322-inbox-provider-host.fixture.mjs';

/** The original provider, card and HTTP writer on both actual Next surfaces. */
export async function verifyProviderCards({ t, language, width, root }) {
  const evidence = path.join(root, 'provider', `${language}-${width}`);
  await mkdir(evidence, { recursive: true });
  const { f, entries, page, errors, posts, results, base } = await openProviderHost({ t, language, width, evidence });
  await page.goto(`${base}/thread/${f.conversationThread.id}?shell=v2`);
  const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
  await draft.fill('Unsent original provider verification draft');
  for (const entry of entries) {
    if (entry.surface === 'inbox' && !(await page.getByTestId('mailbox-close').isVisible()))
      await page.getByTestId('mailbox-button').click();
    const row =
      entry.surface === 'inbox'
        ? page.getByTestId('mailbox-item').filter({ hasText: entry.pending.request.title })
        : null;
    const card = row
      ? row.getByTestId('runtime-interaction-card')
      : page.locator(
          `[data-rich-block-id="${entry.pending.cardRef.blockId}"] [data-testid="runtime-interaction-card"]`,
        );
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    if (!row) {
      // Adopt this position through the history owner's real input path before framing the card.
      const port = await page.locator('[data-chat-container]').boundingBox();
      assert.ok(port);
      await page.mouse.move(port.x + 8, port.y + 24);
      await page.mouse.wheel(0, -1);
      await card.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (element) => {
          const card = element.getBoundingClientRect();
          const port = element.closest('[data-chat-container]').getBoundingClientRect();
          return card.top >= port.top && card.bottom <= port.bottom;
        },
        await card.elementHandle(),
      );
    }
    if (row) {
      assert.equal(await row.getAttribute('data-expanded'), 'false');
      const group = await row.evaluate((el) =>
        el.closest('section[data-testid^="mailbox-group-"]')?.getAttribute('data-testid'),
      );
      assert.equal(group, 'mailbox-group-decisions');
    }
    if (entry.kind === 'question') await card.locator('select[name="environment"]').selectOption('Alpha');
    if (entry.kind === 'form') {
      const accept = card.getByRole('button', { name: language === 'en' ? 'Allow once' : '允许一次', exact: true });
      assert.equal(await accept.isDisabled(), true);
      assert.equal(
        await card.getByRole('button', { name: language === 'en' ? 'Decline' : '拒绝', exact: true }).isEnabled(),
        true,
      );
      await card.locator('select[name="enabled"]').selectOption('false');
    }
    if (entry.kind === 'url') {
      const link = card.getByRole('link');
      assert.equal(await link.getAttribute('href'), 'https://example.invalid/authorize');
      assert.equal(await link.getAttribute('target'), '_blank');
    }
    const bounds = await card.evaluate((el) => el.getBoundingClientRect().toJSON());
    assert.ok(bounds.left >= 0 && bounds.right <= width + 1);
    await page.screenshot({ path: path.join(evidence, `${entry.surface}-${entry.kind}-before.png`), fullPage: true });
    const expected =
      entry.kind === 'question'
        ? { kind: 'answers', answers: { environment: ['Alpha'] } }
        : {
            kind: 'decision',
            decisionId: entry.kind === 'url' ? 'decline' : 'accept',
            ...(entry.kind === 'form' ? { content: { enabled: false } } : {}),
          };
    const buttonName =
      entry.kind === 'question'
        ? language === 'en'
          ? 'Submit answer'
          : '提交回答'
        : entry.kind === 'url'
          ? language === 'en'
            ? 'Decline'
            : '拒绝'
          : language === 'en'
            ? 'Allow once'
            : '允许一次';
    await card.getByRole('button', { name: buttonName, exact: true }).click();
    await entry.settled;
    assert.deepEqual(entry.result(), { response: expected });
    const terminal = await f.store.get(entry.pending.request.interactionId);
    assert.equal(terminal.status, entry.kind === 'url' ? 'declined' : 'answered');
    assert.equal(terminal.source.kind, 'provider_request');
    assert.equal(terminal.returnBinding.kind, 'provider_waiter');
    const posted = posts.filter((post) => post.path.includes(entry.pending.request.interactionId));
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { cardRef: entry.pending.cardRef, response: expected });
    results.push({ surface: entry.surface, kind: entry.kind, initial: entry.pending, terminal, expected, bounds });
  }
  assert.equal(posts.length, 8);
  if (await page.getByTestId('mailbox-close').isVisible()) await page.getByTestId('mailbox-close').click();
  await page.reload();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), 'Unsent original provider verification draft');
  for (const entry of entries) {
    const card = page.locator(
      `[data-rich-block-id="${entry.pending.cardRef.blockId}"] [data-testid="runtime-interaction-card"]`,
    );
    const terminalText =
      entry.kind === 'url'
        ? language === 'en'
          ? 'You declined this request.'
          : '你已拒绝这次请求。'
        : entry.kind === 'question'
          ? language === 'en'
            ? 'Answer submitted.'
            : '回答已提交。'
          : language === 'en'
            ? 'Request handled.'
            : '请求已处理。';
    await card.getByText(terminalText, { exact: true }).waitFor();
    assert.equal(await card.locator('button').count(), 0);
  }
  await page.getByTestId('mailbox-button').click();
  for (const entry of entries)
    assert.equal(await page.getByTestId('mailbox-item').filter({ hasText: entry.pending.request.title }).count(), 0);
  assert.equal((await f.store.readPendingIndexByUser('default-user')).records.length, 0);
  assert.deepEqual(f.queue.list(f.conversationThread.id, 'default-user'), []);
  assert.equal(f.mutations.filter((m) => m.path.endsWith('/messages') || m.path.includes('block-state')).length, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        language,
        width,
        results,
        posts,
        errors,
        boundary:
          'Actual original Next Chat and Inbox; approval/question/form/url with real private provider waiters and HTTP CAS. No live provider, Redis, Alpha or runtime claim.',
      },
      null,
      2,
    ),
  );
}
