import type { SettledApprovalHubItem } from '@cat-cafe/shared';
import { act, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { MailboxPanel } from '../../MailboxPanel';
import { writeShellLanguage } from '../../shell-language';
import { deriveMailboxPanelState } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import type { MailboxSection } from '../mailbox-navigation';
import { useApprovalSessions } from '../use-approval-sessions';
import { OWNER, okRead, storeItem } from './mailbox-fixtures';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));

const settled = (id: string, resolution: 'accepted' | 'rejected', owner = OWNER): SettledApprovalHubItem => ({
  ...storeItem({ proposalId: id, sourceFeatureId: 'F128', summary: `Traceable proposal ${id}`, detail: {} }),
  ownerUserId: owner,
  resolution,
  decidedAt: Date.now() - 1000,
  decidedBy: owner,
  materialization: { state: 'not_started' },
});
const records = [
  settled('accepted', 'accepted'),
  settled('rejected', 'rejected'),
  settled('foreign', 'accepted', 'other'),
];
const view: UnifiedAttentionView = {
  result: okRead([]),
  staleRead: null,
  refetch: vi.fn(),
  resultGeneration: 1,
  readsStarted: () => 1,
};
function Wrapper() {
  const [section, setSection] = useState<MailboxSection>('pending');
  const sessions = useApprovalSessions(view);
  return (
    <MailboxPanel
      anchor={createRef()}
      state={deriveMailboxPanelState(view.result)}
      view={view}
      sessions={sessions}
      section={section}
      onSectionChange={setSection}
      onOpenPlace={vi.fn()}
      onClose={vi.fn()}
    />
  );
}
let host: HTMLDivElement;
let root: Root;
const click = (testId: string) =>
  act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useApprovalHubStore.setState({
    items: [],
    count: 0,
    isLoading: false,
    pendingReadAvailable: true,
    settledItems: [],
    settledIsLoading: false,
    settledError: null,
    selectedIds: new Set(),
    decisionAttempts: {},
  });
  mocks.fetch.mockImplementation(async (url: string) =>
    url === '/api/session'
      ? Response.json({ userId: OWNER })
      : url.startsWith('/api/approval-hub/settled?')
        ? Response.json({ items: records, count: records.length })
        : Response.json({ items: [], count: 0 }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  mocks.fetch.mockReset();
  vi.unstubAllGlobals();
});

it.each([
  'zh',
  'en',
] as const)('opens approval records directly, filters the owner’s history and returns without writing (%s)', async (language) => {
  writeShellLanguage(language);
  await act(async () => root.render(<Wrapper />));
  const handled = document.querySelector('[data-testid="mailbox-history"]');
  await click('mailbox-records');
  const history = document.querySelector('[data-testid="approval-history-content"]');
  expect(history).not.toBeNull();
  expect(handled?.textContent).toBe(language === 'en' ? 'Handled @you' : '已处理的 @你');
  expect(history?.textContent).toContain('Traceable proposal accepted');
  expect(history?.textContent).not.toContain('Traceable proposal foreign');
  if (language === 'en') expect(history?.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  expect(document.querySelector('[data-testid="approval-empty-state"]')).toBeNull();
  expect(document.querySelector('[data-testid="approval-tab-pending"]')?.textContent).toContain(
    language === 'en' ? 'Pending approvals' : '待我处理',
  );
  expect(document.querySelector('[data-testid="approval-history-filter-accepted"]')?.textContent).toBe(
    language === 'en' ? 'Accepted' : '接受',
  );
  await click('approval-history-filter-accepted');
  expect(document.querySelector('[data-testid="settled-card-accepted"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="settled-card-rejected"]')).toBeNull();
  await click('approval-history-filter-clear');
  expect(document.querySelector('[data-testid="settled-card-rejected"]')).not.toBeNull();
  await click('mailbox-records-back');
  expect(document.querySelector('[data-testid="mailbox-tab-needs-me"]')).not.toBeNull();
  expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0);
});
