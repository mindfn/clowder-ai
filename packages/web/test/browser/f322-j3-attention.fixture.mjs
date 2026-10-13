import assert from 'node:assert/strict';
import { projectCompanionDecisions } from '../../../api/dist/routes/companion-decision-projection.js';
import { readUserMentionTodos } from '../../../api/dist/routes/user-mention-todo-projection.js';

/** Controlled inputs, projected by the original F310 producers; never represents real cat work. */
export async function readJ3Attention(url, now) {
  const period = url.searchParams.get('mentionPeriod') ?? 'week';
  const mentions = await readUserMentionTodos(
    {
      async listUserMentionRequests() {
        return Array.from({ length: 3 }, (_, index) => ({
          id: `j3-controlled-mention-${index}`,
          threadId: `thread-j3-controlled-mention-${index}`,
          userId: 'default-user',
          catId: 'codex',
          mentionsUser: true,
          timestamp: now - 1000,
          content: `受控 @你 请求 ${index + 1}，不代表真实猫执行`,
        }));
      },
    },
    'default-user',
    { cutover: 0, now, period },
  );
  const source = (coverage) => ({
    status: 'available',
    exhaustiveness: 'complete',
    startedAt: now - 1000,
    observedAt: now,
    coverage,
  });
  const approval = {
    proposalId: 'j3-controlled-open-approval',
    sourceFeatureId: 'F221',
    requesterCatId: 'codex',
    ownerUserId: 'default-user',
    summary: '受控审批，只有这一项计入角标',
    detail: {},
    navigation: { state: 'legacy_unanchored' },
    inlineApprovable: false,
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: now - 2000,
  };
  return projectCompanionDecisions(
    { items: [approval], coverage: { state: 'complete' } },
    { ownerReads: [], coverage: { state: 'complete' } },
    'default-user',
    { offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 20) },
    now,
    {
      approvals: source('all_registered_F246_producers'),
      needsMe: source('current_linked_F310_five_producers'),
      structuredChoices: source('pending_f306_structured_choices'),
    },
    mentions,
  );
}

export async function assertQualifiedMailboxCounts(page) {
  const button = page.getByTestId('mailbox-button');
  const count = page.getByTestId('mailbox-tab-count');
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="mailbox-panel"]');
    return panel && getComputedStyle(panel).backgroundColor !== 'rgba(0, 0, 0, 0)';
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === '4');
  assert.match(await button.getAttribute('aria-label'), /1 件/);
  assert.equal(await count.innerText(), '4');
  const filters = page.getByTestId('mailbox-mention-controls');
  await filters.getByRole('button', { name: /^更早/ }).press('Enter');
  await page.getByTestId('mailbox-empty').waitFor();
  assert.equal(await count.count(), 0, 'the empty original panel displays its empty message instead of a count pill');
  assert.match(await button.getAttribute('aria-label'), /1 件/);
  await filters.getByRole('button', { name: '这周', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === '4');
  assert.match(await button.getAttribute('aria-label'), /1 件/);
}
