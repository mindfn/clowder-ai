import { createCatId, type ThreadProposal } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ProposalCard } from '../ProposalCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: () => ({ currentThread: { id: 'source-thread', title: '界面设计的原对话' } }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'codex61-sol',
      displayName: '小太阳',
      breedDisplayName: '缅因猫',
      color: { primary: '#886644', secondary: '#ffeecc' },
    }),
  }),
}));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [], currentThreadId: 'source-thread' };
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});

const proposal: ThreadProposal = {
  proposalId: 'proposal-parity',
  status: 'pending',
  sourceThreadId: 'source-thread',
  sourceInvocationId: 'source-invocation',
  sourceCatId: createCatId('codex61-sol'),
  title: '把真实卡片放回对话',
  reason: '同一件事沿用同一张卡。',
  parentThreadId: 'source-thread',
  preferredCats: [createCatId('codex61-sol')],
  initialMessage: '**真相源**\n\n- 先读原对话\n- 保留原来的草稿',
  reportingMode: 'state-transitions',
  declaredWorkMode: 'subtask',
  projectPath: '/isolated/project/cat-cafe',
  createdBy: 'owner-proof',
  createdAt: 1,
  cardMessageId: 'source-card-message',
};
const block: RichCardBlock = {
  id: 'proposal-parity-card',
  kind: 'card',
  v: 1,
  title: `提议新建 thread：${proposal.title}`,
  fields: [
    { label: '父 Thread', value: proposal.parentThreadId },
    { label: '建议成员', value: 'codex61-sol' },
    { label: '项目归属', value: proposal.projectPath },
    { label: '回报模式', value: 'state-transitions' },
    { label: '首条消息', value: proposal.initialMessage! },
  ],
  actions: [{ label: '批准并创建', action: 'propose:approve', payload: { proposalId: proposal.proposalId } }],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async () => Response.json({ proposal }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});
async function render(card: React.ReactNode) {
  await act(async () => root.render(card));
}

it('uses the Inbox producer card and human field names in the Chat entry', async () => {
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.querySelector(`[data-testid="approval-item-${proposal.proposalId}"]`)).not.toBeNull();
  for (const text of ['谁来做', '放在', '怎么跟进', '界面设计的原对话', '每到一个阶段回报一次'])
    expect(host.textContent).toContain(text);
  for (const raw of ['父 Thread', '建议成员', 'state-transitions', proposal.projectPath])
    expect(host.textContent).not.toContain(raw);
});

it('keeps the first message formatted when the original seven-field editor opens', async () => {
  await render(<ProposalCard proposal={proposal} />);
  const edit = [...host.querySelectorAll('button')].find((button) => button.textContent === '编辑');
  expect(edit).toBeDefined();
  await act(async () => edit?.click());
  const preview = host.querySelector('[data-testid="proposal-initial-message-editor-preview"]');
  expect(preview?.querySelector('strong')?.textContent).toBe('真相源');
  expect(preview?.querySelectorAll('li')).toHaveLength(2);
  expect(preview?.textContent).not.toContain('**');
  expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
});

it('restores the same human result from the original producer after a cold Chat read', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      proposal: { ...proposal, status: 'approved', createdThreadId: 'created-thread' },
    }),
  );
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.textContent).toContain('已同意 · 对话已创建');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === '打开新对话')).toBe(true);
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
});

it('does not expose an old actionable engineering card when the original owner read refuses it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'Not the current owner' }, { status: 403 }));
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(host.textContent).not.toContain(proposal.projectPath);
  expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
});

it.each([
  { proposalId: 'foreign-proposal' },
  { cardMessageId: 'foreign-card-message' },
  { sourceThreadId: 'foreign-thread' },
  { preferredCats: 'codex61-sol' },
])('refuses a producer response bound to a different card/source or invalid display fields: %j', async (change) => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ proposal: { ...proposal, ...change } }));
  await render(
    <ProposalCard
      block={block}
      messageId="source-card-message"
      coordinate={{ threadId: 'source-thread', messageId: 'source-card-message', messageRevision: 'source-revision' }}
    />,
  );
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(host.querySelector(`[data-testid="approval-item-${proposal.proposalId}"]`)).toBeNull();
});
