import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { CodexAccountCard } from '../codex-accounts/CodexAccountCard';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import { MemberCodexAccount } from '../codex-accounts/MemberCodexAccount';
import type { ProfileItem } from '../hub-accounts.types';
import { ConfirmProvider } from '../useConfirm';

const request = vi.hoisted(() =>
  vi.fn<(path: string, body: Record<string, unknown>, method?: string) => Promise<Record<string, unknown>>>(
    async () => ({}),
  ),
);
vi.unmock('@/components/useConfirm');
vi.mock('../codex-accounts/account-request', () => ({ accountRequest: request }));
vi.mock('../codex-accounts/CodexBindingControl', () => ({ CodexBindingControl: () => <span>binding preview</span> }));
const profile = (id: string): ProfileItem => ({
  id,
  displayName: id,
  name: id,
  authType: 'oauth',
  kind: 'oauth',
  builtin: false,
  mode: 'subscription',
  clientId: 'openai',
  hasApiKey: false,
  codexLoginStatus: 'ready',
  createdAt: '',
  updatedAt: '',
});
const accounts = [profile('A'), profile('B'), profile('C')];
const cat: CatData = {
  carrier: 'cli',
  id: 'local',
  displayName: 'Local',
  clientId: 'openai',
  cli: { command: 'codex' },
  accountRef: 'A',
  defaultModel: 'fixture',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: [],
  avatar: '/avatars/codex.png',
  roleDescription: 'fixture',
  personality: 'fixture',
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request.mockReset();
  request.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label));
  expect(button).toBeTruthy();
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}
it('remaining credits and native body reset keep their original quota meaning', async () => {
  const reset = '2030-01-02T03:04:05.000Z';
  const observation = {
    observedAt: 1,
    source: 'codex_official_readonly' as const,
    status: 'ok' as const,
    items: [
      { label: '溢出额度', usedPercent: 20, percentKind: 'remaining' as const, poolId: 'codex-overflow' },
      { label: '5小时', usedPercent: 30, percentKind: 'used' as const, poolId: 'codex-main', resetsAt: reset },
    ],
  };
  await act(async () =>
    root.render(<CodexQuotaControl accountRef="A" observation={observation} reload={async () => {}} />),
  );
  expect(container.textContent).toContain('溢出额度：剩余 20%');
  expect(container.textContent).toContain('5小时：剩余 70%');
  expect(container.textContent).toContain(new Date(reset).toLocaleString());
});
it('managed deletion requires explicit danger confirmation, cancel performs no request', async () => {
  const account = {
    ...accounts[0],
    codex: {
      kind: 'managed' as const,
      layoutVersion: 1 as const,
      prepared: true,
      credentialHome: '/fixture/private',
      stateRoot: '/fixture/shared',
      sqliteHome: '/fixture/shared',
      status: 'not_logged_in' as const,
    },
  };
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <CodexAccountCard onUpdated={() => {}} account={account} reload={async () => {}} />
      </ConfirmProvider>,
    ),
  );
  await click('删除账号条目');
  expect(request).not.toHaveBeenCalled();
  expect(container.textContent).toContain('文件和登录');
  await click('取消');
  expect(request).not.toHaveBeenCalled();
  await click('删除账号条目');
  await click('确认删除');
  expect(request).toHaveBeenCalledWith('/api/accounts/A', {}, 'DELETE');
});
it('closed member selector follows authoritative binding, open user edit survives external changes', async () => {
  await act(async () => root.render(<MemberCodexAccount cat={cat} accounts={accounts} />));
  await act(async () => root.render(<MemberCodexAccount cat={{ ...cat, accountRef: 'B' }} accounts={accounts} />));
  await click('换账号');
  const select = container.querySelector('select');
  if (!select) throw new Error('Missing member account selector');
  expect(select.value).toBe('B');
  await act(async () => root.render(<MemberCodexAccount cat={cat} accounts={accounts} />));
  expect(select.value).toBe('A');
  await act(async () => {
    select.value = 'C';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => root.render(<MemberCodexAccount cat={{ ...cat, accountRef: 'B' }} accounts={accounts} />));
  expect(select.value).toBe('C');
  await click('换账号');
  await click('换账号');
  expect(container.querySelector('select')?.value).toBe('B');
});
it('different official accounts with the same note remain distinguishable in the member picker', async () => {
  const sameNotes = ['A', 'B'].map((id) => ({
    ...profile(id),
    displayName: 'Codex 账号',
    codex: {
      kind: 'managed' as const,
      layoutVersion: 1 as const,
      prepared: true,
      credentialHome: `/fixture/${id}`,
      stateRoot: '/fixture/shared',
      sqliteHome: '/fixture/shared',
      status: 'ready' as const,
      identity: { userId: `user-${id}`, workspaceId: `workspace-${id}`, email: `${id}@example.test` },
    },
  }));
  await act(async () => root.render(<MemberCodexAccount cat={cat} accounts={sameNotes} />));
  await click('换账号');
  const labels = [...container.querySelectorAll('option')].map((option) => option.textContent);
  expect(labels[0]).toContain('A@example.test');
  expect(labels[1]).toContain('B@example.test');
  expect(labels[0]).not.toBe(labels[1]);
});

it('historical reuse has no binding action when its destination disappears or becomes unavailable', async () => {
  const candidate = {
    ...profile('candidate'),
    codex: {
      kind: 'managed' as const,
      layoutVersion: 1 as const,
      prepared: true,
      credentialHome: '/fixture/candidate',
      stateRoot: '/fixture/shared',
      sqliteHome: '/fixture/shared',
      status: 'not_logged_in' as const,
      attempt: {
        id: 'attempt',
        revision: 1,
        ownerBootId: 'boot',
        ownerPid: 1,
        ownerStartedAt: 'fixture',
        createdAt: 1,
        updatedAt: 2,
        credentialHome: '/fixture/stage',
        state: 'reused' as const,
        duplicateAccountRef: 'A',
      },
    },
  };
  const destination = { ...profile('A'), codex: { ...candidate.codex, attempt: undefined, status: 'ready' as const } };
  const render = async (items: ProfileItem[]) =>
    act(async () =>
      root.render(
        <ConfirmProvider>
          <CodexAccountCard onUpdated={() => {}} account={candidate} accounts={items} reload={async () => {}} />
        </ConfirmProvider>,
      ),
    );
  await render([destination, candidate]);
  expect(container.textContent).toContain('binding preview');
  await render([candidate]);
  expect(container.textContent).not.toContain('binding preview');
  expect(container.textContent).toContain('不可用');
  await render([{ ...destination, codex: { ...destination.codex, status: 'identity_changed' } }, candidate]);
  expect(container.textContent).not.toContain('binding preview');
  expect(request).not.toHaveBeenCalled();
});

const waitingAttempt = {
  id: 'attempt',
  revision: 1,
  ownerBootId: 'boot',
  ownerPid: 1,
  ownerStartedAt: 'fixture',
  state: 'waiting' as const,
  credentialHome: '/fixture/attempt',
  createdAt: 1,
  updatedAt: 1,
};

const pendingAccount = () => ({
  ...profile('pending'),
  codex: {
    kind: 'managed' as const,
    layoutVersion: 1 as const,
    prepared: true,
    credentialHome: '/fixture/private',
    stateRoot: '/fixture/shared',
    sqliteHome: '/fixture/shared',
    status: 'not_logged_in' as const,
  },
});
it('a failed login request releases controls even when account reload never settles', async () => {
  const reload = vi.fn(() => new Promise<void>(() => {}));
  request.mockRejectedValueOnce(new Error('网络请求超时'));
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <CodexAccountCard onUpdated={() => {}} account={pendingAccount()} reload={reload} />
      </ConfirmProvider>,
    ),
  );
  await click('开始官方登录');
  expect(container.textContent).toContain('网络请求超时');
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.find((b) => b.textContent?.includes('开始官方登录'))?.disabled).toBe(false);
  expect(buttons.find((b) => b.textContent?.includes('删除账号条目'))?.disabled).toBe(false);
});
it('an unlogged account has no quota or binding action', async () => {
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <CodexAccountCard onUpdated={() => {}} account={pendingAccount()} reload={async () => {}} />
      </ConfirmProvider>,
    ),
  );
  expect(container.textContent).not.toContain('查询此账号额度');
  expect(container.textContent).not.toContain('binding preview');
});
it('active deletion delegates validation and cancellation to the server', async () => {
  const account = pendingAccount();
  const attempt = waitingAttempt;
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <CodexAccountCard
          onUpdated={() => {}}
          account={{ ...account, codex: { ...account.codex, attempt } }}
          reload={async () => {}}
        />
      </ConfirmProvider>,
    ),
  );
  await click('删除账号条目');
  await click('确认删除');
  expect(request.mock.calls).toEqual([['/api/accounts/pending', {}, 'DELETE']]);
});

it('successful retry publishes waiting immediately, before a hung list reload', async () => {
  const initial = pendingAccount();
  const waiting = {
    ...initial,
    codex: {
      ...initial.codex,
      attempt: { ...waitingAttempt, id: 'attempt-new', revision: 2, createdAt: 2, updatedAt: 2 },
    },
  };
  request.mockResolvedValueOnce({ accountRef: initial.id, codex: waiting.codex, profiles: [waiting] });
  const reload = vi.fn(() => new Promise<void>(() => {}));
  const updated = vi.fn();
  function AccountHarness() {
    const [account, setAccount] = useState<ProfileItem>(initial);
    return (
      <CodexAccountCard
        account={account}
        reload={reload}
        onUpdated={(profiles: ProfileItem[]) => {
          updated(profiles);
          setAccount(profiles.find((p) => p.id === initial.id)!);
        }}
      />
    );
  }
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <AccountHarness />
      </ConfirmProvider>,
    ),
  );
  await click('开始官方登录');
  expect(container.textContent).toContain('终端已打开');
  expect(container.textContent).not.toContain('开始官方登录');
  expect(updated).toHaveBeenCalledWith([waiting]);
  expect(reload).toHaveBeenCalledOnce();
  expect([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('取消本次登录'))?.disabled).toBe(
    false,
  );
});
it('bound active deletion failure preserves the current login and its cancel control', async () => {
  const initial = pendingAccount();
  const attempt = waitingAttempt;
  request.mockImplementation(async (path) => {
    if (path === '/api/accounts/pending') throw new Error('Account is still referenced');
    return {};
  });
  await act(async () =>
    root.render(
      <ConfirmProvider>
        <CodexAccountCard
          onUpdated={() => {}}
          account={{ ...initial, codex: { ...initial.codex, attempt } }}
          reload={async () => {}}
        />
      </ConfirmProvider>,
    ),
  );
  await click('删除账号条目');
  await click('确认删除');
  expect(request.mock.calls).toEqual([['/api/accounts/pending', {}, 'DELETE']]);
  expect(container.textContent).toContain('Account is still referenced');
  expect(container.textContent).toContain('终端已打开');
});

it('unlogged default OAuth cannot be selected for rebinding, while API Key selection is preserved', async () => {
  const items: ProfileItem[] = [
    { ...profile('codex'), builtin: true, codexLoginStatus: 'not_logged_in' },
    { ...profile('key'), authType: 'api_key', kind: 'api_key', mode: 'api_key' },
  ];
  await act(async () => root.render(<MemberCodexAccount cat={{ ...cat, accountRef: 'codex' }} accounts={items} />));
  await click('换账号');
  expect([...container.querySelectorAll('option')].map((option) => option.value)).toEqual(['key']);
  expect(container.textContent).not.toContain('binding preview');
});
