import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The mailbox consumer and real owner writers; only the browser transport is isolated. */
export function registerMentionCutoverJourney({ test, openProof, closeProof }) {
  test('558 historical requests → clean badge → time filters → bulk confirmation → handled history → one undo', async () => {
    const require = createRequire(new URL('../../../api/package.json', import.meta.url));
    const Fastify = require('fastify');
    // Keep the real TS owners runnable under the canonical plain-Node command.
    const { register } = require('tsx/esm/api');
    const unregister = register();
    const [{ MessageStore }, { companionDecisionRoutes }, { InMemoryRuntimeInteractionStore }] = await Promise.all([
      import('../../../api/src/domains/cats/services/stores/ports/MessageStore.ts'),
      import('../../../api/src/routes/companion-decision-routes.ts'),
      import('../../../api/src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.ts'),
    ]).finally(unregister);
    const previous = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const app = Fastify();
    const messages = new MessageStore();
    const now = Date.now();
    const source = {
      userId: 'owner-1',
      catId: 'codex61-sol',
      threadId: 'f320',
      content: '@co-creator\n需要你重启。建议空闲时更新；今天不答会继续运行旧版。',
      mentions: [],
      mentionsUser: true,
      timestamp: now + 1,
    };
    for (let n = 0; n < 558; n++)
      messages.append({ ...source, threadId: `legacy-${n}`, timestamp: now - 25 * 86400000 });
    app.addHook('preHandler', async (r) => {
      r.sessionUserId = 'owner-1';
    });
    app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
    app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
    await app.register(companionDecisionRoutes, {
      ownerUserId: 'owner-1',
      messageStore: messages,
      runtimeInteractionStore: new InMemoryRuntimeInteractionStore(),
      now: () => now,
      threadStore: {
        get: (id) => ({ createdBy: 'owner-1', title: id === 'f320' ? 'F320 登录修复' : `磁盘清理 · 旧请求 ${id}` }),
      },
    });
    const proof = await openProof({
      viewport: { width: 1024, height: 820 },
      unified: async (_a, { url }) => {
        const r = await app.inject(url.pathname + url.search);
        return { status: r.statusCode, body: r.json() };
      },
      api: async ({ request, url }) => {
        if (url.pathname === '/api/approval-hub/settled') return { body: { items: [] } };
        if (!url.pathname.startsWith('/api/concierge/work/mentions/')) return null;
        const r = await app.inject({
          method: request.method(),
          url: url.pathname + url.search,
          headers: { origin: 'http://localhost' },
          ...(request.method() === 'POST' ? { payload: request.postDataJSON() } : {}),
        });
        return { status: r.statusCode, body: r.json() };
      },
    });
    const { page } = proof;
    const invalidate = () => page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:user-mention-updated')));
    try {
      await page.getByTestId('mailbox-button').click();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(await page.getByTestId('mailbox-item').count(), 0);
      assert.equal(await page.getByRole('button', { name: '更早 · 558', exact: true }).count(), 1);
      messages.append(source);
      await invalidate();
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.match(await page.getByTestId('mailbox-item-toggle').innerText(), /F320 登录修复/);
      assert.match(await page.getByTestId('mailbox-mention-preview').innerText(), /需要你重启/);
      assert.doesNotMatch(await page.getByTestId('mailbox-item-toggle').innerText(), /有事找你/);
      const out = process.env.F322_USER_MENTION_EVIDENCE_DIR;
      if (out) {
        mkdirSync(out, { recursive: true });
        await page.screenshot({ path: path.join(out, 'cutover-recent.png'), fullPage: true });
      }
      await page.getByRole('button', { name: '更早 · 558', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 20);
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-next-page').click();
      await page.getByText('第 2 页', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-mentions-handle-selected').click();
      await page.getByRole('alertdialog').waitFor();
      assert.match(await page.getByRole('alertdialog').innerText(), /更早的 558 件/);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '这周', exact: true }).click();
      await page.getByTestId('mailbox-mentions-handle-selected').filter({ hasText: '这 1 件' }).waitFor();
      await page.getByTestId('mailbox-mentions-handle-selected').click();
      await page.getByRole('button', { name: '确认处理 1 件', exact: true }).click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '1 件' }).waitFor();
      assert.equal(messages.listUserMentionRequests('owner-1').length, 558);
      await page.getByTestId('mailbox-history').click();
      await page.getByTestId('mailbox-title').filter({ hasText: '已处理的 · 1' }).waitFor();
      assert.equal(await page.getByText('类型', { exact: true }).count(), 0);
      await page.getByTestId('mailbox-item-toggle').click();
      await page.getByTestId('mailbox-mention-restore').click();
      await page.getByTestId('mailbox-handled-back').click();
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(messages.listUserMentionRequests('owner-1').length, 559);
      assert.equal(
        await page.getByTestId('mailbox-mentions-handle-all').innerText(),
        '把全部 559 件 @你 请求标为已处理',
      );
      await page.getByTestId('mailbox-mentions-handle-all').click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /这周 1 件、更早 558 件/);
      const primary = page.getByRole('button', { name: '确认处理 559 件', exact: true });
      assert.notEqual(await primary.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      await primary.click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '559 件' }).waitFor();
      assert.equal(messages.listUserMentionRequests('owner-1').length, 0);
      assert.equal(await page.getByTestId('mailbox-mentions-handle-selected').count(), 0);
      assert.equal(await page.getByTestId('mailbox-mentions-handle-all').count(), 0);
      assert.equal(await page.getByTestId('mailbox-state-text').innerText(), '暂无待办');
      assert.equal(await page.getByTestId('mailbox-empty').count(), 1);
      await page.getByTestId('mailbox-empty').waitFor();
      if (out) await page.screenshot({ path: path.join(out, 'cutover-handled-undo.png'), fullPage: true });
      await page.getByTestId('mailbox-history').click();
      await page.getByTestId('mailbox-title').filter({ hasText: '已处理的 · 559' }).waitFor();
      await page.getByTestId('mailbox-mentions-undo').waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 20);
      assert.equal(await page.getByText('类型', { exact: true }).count(), 0);
      if (out) await page.screenshot({ path: path.join(out, 'cutover-history.png'), fullPage: true });
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).click();
      await page.getByTestId('mailbox-mention-restore').click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '剩 558 件' }).waitFor();
      await page.getByTestId('mailbox-handled-back').click();
      await page.reload();
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '剩 558 件' }).waitFor();
      await page.getByTestId('mailbox-history').click();
      await page.getByTestId('mailbox-mentions-undo').click();
      await page.getByRole('status').filter({ hasText: '已撤销 558 件' }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(messages.listUserMentionRequests('owner-1').length, 559);
      assert.equal(await page.getByTestId('mailbox-mentions-undo').count(), 0);
      assert.equal(await page.getByText('已处理 559 件 @你 请求。', { exact: true }).count(), 0);
      await page.getByTestId('mailbox-handled-back').click();
      await page.getByRole('button', { name: '更早 · 558', exact: true }).waitFor();
    } finally {
      await closeProof(proof);
      await app.close();
      if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previous;
    }
  });
}
