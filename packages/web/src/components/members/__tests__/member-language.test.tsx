import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { HubCatEditor } from '../../HubCatEditor';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
const cat: CatData = {
  id: 'language-fixture',
  name: 'Test member',
  displayName: 'Test member',
  nickname: 'Tester',
  avatar: '/avatars/family/codex61-sol.png',
  color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
  mentionPatterns: ['@tester'],
  carrier: 'cli',
  clientId: 'anthropic',
  defaultModel: 'test-model',
  accountRef: 'claude',
  roleDescription: 'Review partner',
  personality: '',
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('en');
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/accounts'
            ? {
                providers: [
                  {
                    id: 'claude',
                    name: 'Claude',
                    displayName: 'Claude',
                    clientId: 'anthropic',
                    authType: 'oauth',
                    kind: 'builtin',
                    builtin: true,
                    models: [],
                  },
                ],
              }
            : {},
        ),
      ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellLanguage('zh');
  vi.clearAllMocks();
});
async function renderMember(member = cat) {
  await act(async () =>
    root.render(
      <MemberCopyProvider>
        <HubCatEditor open presentation="page" cat={member} onClose={vi.fn()} onSaved={vi.fn()} />
      </MemberCopyProvider>,
    ),
  );
}
function expectEnglish() {
  const copy = container.textContent ?? '';
  expect(copy.match(/[^\n.!?]*[\p{Script=Han}][^\n.!?]*/gu) ?? []).toEqual([]);
}
it('renders English labels and voice options, including the collapsed helper', async () => {
  await renderMember();
  expectEnglish();
  const voice = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Voice settings');
  expect(voice).toBeTruthy();
  await act(async () => voice?.click());
  expectEnglish();
});
it.each([
  'anthropic',
  'opencode',
] as const)('uses an English model placeholder for %s without translating model IDs', async (clientId) => {
  await renderMember({ ...cat, clientId });
  const model = container.querySelector<HTMLInputElement>('input[aria-label="Model"]');
  expect(model?.placeholder).toBe(
    clientId === 'opencode' ? 'openai/gpt-5.4 / openrouter/google/gemini-3-flash-preview' : 'Model ID',
  );
  expect(model?.value).toBe('test-model');
});
it('renders Native fields and its original model validation in English', async () => {
  const originalRead = vi.mocked(apiFetch).getMockImplementation();
  if (!originalRead) throw Error('fixture read missing');
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    url === '/api/accounts'
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              providers: [
                {
                  id: 'gemini',
                  clientId: 'google',
                  displayName: 'Gemini',
                  authType: 'oauth',
                  kind: 'builtin',
                  builtin: true,
                  models: [],
                },
              ],
            }),
          ),
        )
      : originalRead(url, init),
  );
  await renderMember({ ...cat, clientId: 'google', accountRef: 'gemini' });
  const transport = container.querySelector<HTMLSelectElement>('select[aria-label="Transport"]');
  await act(async () => {
    if (!transport) throw Error('Transport missing');
    transport.value = 'agy-native';
    transport.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expectEnglish();
  expect(
    container.querySelector('textarea[aria-label="Approved workspaces"]')?.closest('label')?.textContent,
  ).toContain('Approved workspaces');
  expect(container.textContent).toContain('denied outright');
  const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save');
  await act(async () => save?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'AGY Native needs at least one approved workspace.',
  );
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});
it.each(['healthy', 'drifted'] as const)('explains protected cloud identity in English (%s)', async (state) => {
  await renderMember({
    ...cat,
    id: 'gpt-pro',
    mentionPatterns: ['@gpt-pro'],
    identityProtection: {
      kind: 'builtin-cloud',
      state,
      lockedFields: ['clientId', 'defaultModel', 'accountRef'],
      driftedFields: state === 'drifted' ? ['defaultModel'] : [],
    },
  });
  expectEnglish();
  expect(container.textContent).toContain('ChatGPT Pro');
});
it('keeps the classic modal copy when the durable v2 preference is English', async () => {
  await act(async () => root.render(<HubCatEditor open cat={cat} onClose={vi.fn()} onSaved={vi.fn()} />));
  const modal = document.querySelector('[role="dialog"]');
  expect(modal?.textContent).toContain('认证与模型');
  expect(modal?.textContent).toContain('身份信息');
  expect(modal?.textContent).not.toContain('Model & connection');
  expect(modal?.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.placeholder).toBe(
    '模型标识符，如 claude-sonnet-4-5',
  );
});
it.each([
  ['zh', '添加', '还差 4 项才能添加：账号、名称、角色描述、@ 名字。'],
  ['en', 'Add', '4 more fields needed to add: Account, Name, Role, Mention names.'],
] as const)('uses v2 required-field copy after an untouched %s add is submitted', async (language, button, message) => {
  writeShellLanguage(language);
  const originalRead = vi.mocked(apiFetch).getMockImplementation();
  if (!originalRead) throw Error('fixture read missing');
  vi.mocked(apiFetch).mockImplementation((url, init) =>
    url === '/api/cat-templates'
      ? Promise.resolve(new Response(JSON.stringify({ templates: [] })))
      : originalRead(url, init),
  );
  await act(async () =>
    root.render(
      <MemberCopyProvider>
        <HubCatEditor open presentation="page" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemberCopyProvider>,
    ),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === button);
  expect(submit).toBeTruthy();
  expect(submit?.disabled).toBe(false);
  await act(async () => submit?.click());
  const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((a) => a.textContent);
  expect(alerts[0]).toBe(message);
  expect(alerts[1]).toContain(language === 'en' ? 'Your changes are still here' : '修改还在');
  expect(container.querySelector('input[aria-label="Name"]')?.getAttribute('aria-invalid')).toBe('true');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});
