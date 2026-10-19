import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxOriginalApprovalFixture } from './f322-inbox-original-approval.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
async function pressDecision(page, button, path) {
  await button.waitFor();
  await page.waitForFunction((button) => !button.disabled, await button.elementHandle());
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST');
  await button.focus();
  await page.keyboard.press('Enter');
  assert.equal((await response).status(), 200);
}
async function settleAnimations(page) {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function freezeVisibleCard(page, card) {
  await card.scrollIntoViewIfNeeded();
  await settleAnimations(page);
  await page.waitForFunction(
    (element) => {
      for (let node = element; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 0.99) return false;
      }
      return element.getBoundingClientRect().height > 0;
    },
    await card.elementHandle(),
  );
}
function decisionLabel(kind, language, verb) {
  if (verb === 'reject') return language === 'en' ? 'Reject' : '驳回';
  return kind === 'F225'
    ? language === 'en'
      ? 'Approve and hand off'
      : '批准并接力'
    : language === 'en'
      ? 'Approve and write'
      : '批准并写入';
}
export function registerOriginalApprovalJourneys(evidenceRoot) {
  const inverse = process.env.F322_ORIGINAL_APPROVAL_INVERSE === '1';
  for (const language of ['zh', 'en'])
    for (const width of [1440, 390])
      test(`F322 original F225/F231 Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
        const evidence = path.join(evidenceRoot, 'original-approvals', `${language}-${width}`);
        await mkdir(evidence, { recursive: true });
        const f = await createInboxOriginalApprovalFixture(language),
          sources = f.approvalSources;
        const chatRecords = inverse ? sources.records.slice(2) : sources.records.slice(0, 2),
          inboxRecords = inverse ? sources.records.slice(0, 2) : sources.records.slice(2),
          chatVerb = inverse ? 'reject' : 'approve',
          inboxVerb = inverse ? 'approve' : 'reject';
        const approvedRecord = sources.records[0],
          rejectedRecord = sources.records[2];
        let env, server, browser, page;
        const errors = [],
          decisions = [];
        t.after(async () => {
          try {
            if (page && !page.isClosed()) {
              await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
              await writeFile(
                path.join(evidence, 'final-state.json'),
                JSON.stringify(
                  {
                    text: await page.locator('body').innerText(),
                    errors,
                    decisions,
                    mutations: f.mutations,
                    reads: f.reads,
                    handoffs: await Promise.all(
                      sources.records.filter((r) => r.kind === 'F225').map((r) => sources.handoffs.get(r.proposalId)),
                    ),
                    profiles: await Promise.all(
                      sources.records.filter((r) => r.kind === 'F231').map((r) => sources.profiles.get(r.proposalId)),
                    ),
                    queue: sources.queue.list(approvedRecord.thread.id, 'default-user'),
                    profileContent: await sources.readProfile(),
                  },
                  null,
                  2,
                ),
              );
            }
          } finally {
            const cleanup = await Promise.allSettled([
              browser?.close(),
              server ? stopChild(server) : undefined,
              env?.cleanup(),
              f.close(),
            ]);
            const failed = cleanup.filter((r) => r.status === 'rejected');
            if (failed.length)
              throw new AggregateError(
                failed.map((r) => r.reason),
                'Owned journey cleanup failed',
              );
          }
        });
        const port = await availablePort();
        env = await createNextDevTestEnvironment(`f322-original-approval-${language}-${width}`, {
          API_SERVER_PORT: String(f.apiPort),
          NEXT_PUBLIC_API_URL: `http://127.0.0.1:${f.apiPort}`,
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
          { cwd: web, env: env.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        for (const stream of [server.stdout, server.stderr])
          stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
        const base = `http://127.0.0.1:${port}`;
        await waitForHttp(`${base}/thread/${chatRecords[0].thread.id}`, server);
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage({ viewport: { width, height: 1000 } });
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
          const pathname = new URL(request.url()).pathname;
          if (
            request.method() === 'POST' &&
            /^\/api\/(session-handoff|profile-updates)\/[^/]+\/(approve|reject)$/.test(pathname)
          )
            decisions.push({ path: pathname, body: request.postDataJSON() });
        });
        await page.addInitScript((lang) => {
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          localStorage.setItem('cat-cafe:shell-language', lang);
        }, language);
        await page.goto(`${base}/thread/${chatRecords[0].thread.id}?shell=v2`);
        await page.locator(`[data-rich-block-id="${chatRecords[1].block.id}"]`).waitFor();
        const chatRender = [];
        for (const record of chatRecords) {
          const card = page.locator(`[data-rich-block-id="${record.block.id}"]`);
          await freezeVisibleCard(page, card);
          const disclosure = card.getByTestId('original-approval-long-content');
          assert.equal(await disclosure.getAttribute('open'), null);
          assert.equal(await disclosure.getByRole('region').isVisible(), false);
          const text = await card.innerText();
          assert.ok(
            !text.includes('default-user') && !text.includes(record.proposalId) && !text.includes('relationship/'),
          );
          const box = await card.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
          chatRender.push({ kind: record.kind, text, box, longContentClosed: true });
          await page.screenshot({ path: path.join(evidence, `chat-${record.kind}-before.png`), fullPage: true });
          const prefix = record.kind === 'F225' ? 'session-handoff' : 'profile-updates';
          await pressDecision(
            page,
            card.getByRole('button', { name: decisionLabel(record.kind, language, chatVerb), exact: true }),
            `/api/${prefix}/${record.proposalId}/${chatVerb}`,
          );
          await card.getByTestId('original-approval-terminal').waitFor();
          await freezeVisibleCard(page, card);
          await page.screenshot({ path: path.join(evidence, `chat-${record.kind}-after.png`), fullPage: true });
        }
        assert.equal(await sources.readProfile(), inverse ? sources.before : sources.after);
        assert.equal(sources.queue.list(chatRecords[0].thread.id, 'default-user').length, inverse ? 0 : 1);
        await page.getByTestId('mailbox-button').click();
        const render = [];
        for (const record of inboxRecords) {
          const card = page.locator(`[data-testid="original-approval-card"][data-proposal-id="${record.proposalId}"]`);
          await card.waitFor();
          await card.scrollIntoViewIfNeeded();
          await settleAnimations(page);
          const disclosure = card.getByTestId('original-approval-long-content');
          assert.equal(await disclosure.getAttribute('open'), null);
          assert.equal(await disclosure.getByRole('region').isVisible(), false);
          const row = card.locator('xpath=ancestor::li');
          assert.equal(await row.getAttribute('data-expanded'), 'false');
          const text = await card.innerText();
          assert.ok(
            !text.includes('default-user') && !text.includes(record.proposalId) && !text.includes(record.card.id),
          );
          assert.ok(text.includes(record.thread.title));
          const box = await card.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
          render.push({ kind: record.kind, text, box, longContentClosed: true });
          await page.screenshot({ path: path.join(evidence, `inbox-${record.kind}-closed.png`), fullPage: true });
          await disclosure.locator('summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await disclosure.getByRole('region').isVisible(), true);
          const region = disclosure.getByRole('region');
          const regionBox = await region.boundingBox();
          assert.ok(regionBox.height <= 257, 'Long content has a bounded scroll region');
          await region.focus();
          await page.keyboard.press('End');
          await page.screenshot({ path: path.join(evidence, `inbox-${record.kind}-open.png`), fullPage: true });
          const prefix = record.kind === 'F225' ? 'session-handoff' : 'profile-updates';
          await pressDecision(
            page,
            card.getByRole('button', { name: decisionLabel(record.kind, language, inboxVerb), exact: true }),
            `/api/${prefix}/${record.proposalId}/${inboxVerb}`,
          );
          const settled =
            record.kind === 'F225' ? sources.handoffs.get(record.proposalId) : sources.profiles.get(record.proposalId);
          assert.equal(settled.status, inverse ? 'approved' : 'rejected');
          const effect =
            record.kind === 'F225'
              ? language === 'en'
                ? 'Handoff started'
                : '接力已发起'
              : language === 'en'
                ? 'Profile written'
                : '档案已写入';
          await page
            .getByTestId('mailbox-retained-line')
            .filter({ hasText: inverse ? effect : language === 'en' ? 'Rejected' : '已拒绝' })
            .first()
            .waitFor();
        }
        assert.equal(await sources.readProfile(), sources.after, 'Reject cannot overwrite the approved profile');
        const approvedHandoff = sources.handoffs.get(approvedRecord.proposalId);
        assert.equal(approvedHandoff.status, 'approved');
        assert.equal(sources.sessions.get(approvedHandoff.sourceSessionId).status, 'sealed');
        assert.equal(
          sources.sessions.get(approvedHandoff.sourceSessionId).catHandoffNote.proposalId,
          approvedHandoff.proposalId,
        );
        assert.equal(sources.queue.list(approvedRecord.thread.id, 'default-user').length, 1);
        const rejectedHandoff = sources.handoffs.get(rejectedRecord.proposalId);
        assert.equal(sources.sessions.get(rejectedHandoff.sourceSessionId).status, 'active');
        assert.equal(sources.queue.list(rejectedRecord.thread.id, 'default-user').length, 0);
        assert.equal(sources.seals.length, 1);
        assert.equal(decisions.length, 4);
        assert.ok(decisions.every((d) => JSON.stringify(d.body) === '{}'));
        assert.ok(
          f.reads.some((r) => r.items.some((i) => i.originalApprovalCard && i.approval.inlineApprovable === false)),
        );
        await settleAnimations(page);
        const resultText = await page.getByTestId('mailbox-retained-result').allTextContents();
        assert.ok(resultText.every((text) => !text.includes('**') && !text.includes('default-user')));
        if (inverse) assert.ok(resultText.every((text) => !/Effect not yet confirmed|效果暂未确认/.test(text)));
        await page.screenshot({ path: path.join(evidence, 'inbox-results.png'), fullPage: true });
        await page.reload();
        await page.getByTestId('mailbox-button').click();
        await page.getByTestId('mailbox-panel').waitFor();
        await page.getByTestId('approval-item-inbox-native-approve').waitFor();
        assert.equal(await page.getByTestId('original-approval-card').count(), 0);
        const settledResponse = await fetch(`http://127.0.0.1:${f.apiPort}/api/approval-hub/settled?limit=200`, {
          headers: { 'x-cat-cafe-user': 'default-user' },
        });
        assert.equal(settledResponse.status, 200);
        const settled = await settledResponse.json();
        assert.deepEqual(
          settled.items.map((r) => r.proposalId).sort(),
          sources.records.map((r) => r.proposalId).sort(),
        );
        assert.equal(
          f.mutations.filter((m) => /^\/api\/(session-handoff|profile-updates)\/[^/]+\/(approve|reject)$/.test(m.path))
            .length,
          4,
        );
        assert.equal(
          f.mutations.some(
            (m) => m.path.includes('block-state') || (m.method === 'POST' && m.path.includes('/approval-hub/')),
          ),
          false,
        );
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(evidence, 'proof.json'),
          JSON.stringify(
            {
              language,
              width,
              chatVerb,
              inboxVerb,
              chatRender,
              resultText,
              decisions,
              render,
              approvedHandoff,
              rejectedHandoff,
              profiles: sources.records.filter((r) => r.kind === 'F231').map((r) => sources.profiles.get(r.proposalId)),
              profileContent: await sources.readProfile(),
              queue: sources.queue.list(approvedRecord.thread.id, 'default-user'),
              seals: sources.seals,
              settled,
              mutations: f.mutations,
              reads: f.reads,
              errors,
              boundary:
                'Real Next Chat/Inbox, original F225/F231 private stores/owner routes/F310 proof/approval session history and private profile filesystem writer. Sealer is bounded injection; no transcript exporter, live provider, Redis durability, Alpha/runtime or whole17 claim.',
            },
            null,
            2,
          ),
        );
      });
}
