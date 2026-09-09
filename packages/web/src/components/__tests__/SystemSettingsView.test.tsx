import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import type { EnvVar } from '@/components/settings/EnvSubComponents';
import { SystemSettingsView } from '@/components/settings/SystemSettingsView';

const mockApiFetch = vi.mocked(apiFetch);

const EDITABLE_DIR_VAR: EnvVar = {
  name: 'DATA_DIR',
  defaultValue: '/data',
  description: '持久数据根目录',
  category: 'storage',
  sensitive: false,
  runtimeEditable: true,
  label: '数据根目录',
  settingsGroup: 'storage',
  restartRequired: true,
  control: 'dirpicker',
  currentValue: '/data',
};

const READONLY_VAR: EnvVar = {
  name: 'KIMI_CONFIG_FILE',
  defaultValue: '(平台默认)',
  description: 'Kimi 配置文件路径',
  category: 'kimi',
  sensitive: false,
  runtimeEditable: false,
  label: 'Kimi 配置',
  settingsGroup: 'network',
  currentValue: '/etc/kimi/config.json',
};

const NUMBER_VAR: EnvVar = {
  name: 'MESSAGE_TTL_SECONDS',
  defaultValue: '604800',
  placeholder: '604800 = 7天',
  description: '消息过期时间（秒）',
  category: 'storage',
  sensitive: false,
  runtimeEditable: true,
  label: '消息过期时间',
  settingsGroup: 'lifecycle',
  restartRequired: true,
  control: 'number',
  currentValue: null,
};

const TOGGLE_VAR: EnvVar = {
  name: 'MEMORY_STORE',
  defaultValue: '(未设置)',
  description: '当 Redis 不可用时允许以内存模式启动',
  category: 'storage',
  sensitive: false,
  runtimeEditable: true,
  label: '内存模式（后备）',
  settingsGroup: 'storage',
  restartRequired: true,
  booleanSemantics: { defaultOn: false, trueWhen: 'exactOne' },
  currentValue: null,
};

const GROUP_LABELS = { storage: '存储', network: '网络' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith(text)) as
    | HTMLButtonElement
    | undefined;
}

describe('SystemSettingsView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    vi.clearAllMocks();
  });

  async function renderView(variables: EnvVar[], onSaved?: () => void) {
    await act(async () => {
      root.render(React.createElement(SystemSettingsView, { variables, groupLabels: GROUP_LABELS, onSaved }));
    });
    await flushEffects();
    // Editable restart vars live behind the collapsible advanced section.
    const expand = findButton(container, '展开高级信息（端口、路径、TTL 等）');
    if (expand) {
      await act(async () => {
        expand.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flushEffects();
    }
  }

  it('renders a clickable picker for editable dirpicker vars and saves the picked path', async () => {
    const onSaved = vi.fn();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/dir-list?path=%2Fdata' && !init?.method) {
        return Promise.resolve(
          jsonResponse({ path: '/data', parent: '/', entries: [{ name: 'vault', path: '/data/vault' }] }),
        );
      }
      if (path === '/api/config/dir-list?path=%2Fdata%2Fvault' && !init?.method) {
        return Promise.resolve(jsonResponse({ path: '/data/vault', parent: '/data', entries: [] }));
      }
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await renderView([EDITABLE_DIR_VAR, READONLY_VAR], onSaved);

    const pathText = Array.from(container.querySelectorAll('span')).find(
      (el) => el.getAttribute('aria-label') === '数据根目录',
    );
    expect(pathText).toBeTruthy();
    expect(pathText?.textContent).toBe('/data');
    expect(container.querySelector('input[aria-label="数据根目录"]')).toBeNull();
    const pickButton = findButton(container, '修改');
    expect(pickButton).toBeTruthy();
    expect(pickButton?.disabled).toBe(false);

    // Save starts disabled (no draft change yet).
    expect(findButton(container, '保存到 .env')?.disabled).toBe(true);

    // Pick a new directory through the browser modal.
    await act(async () => {
      pickButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    const vaultEntry = findButton(container, 'vault/');
    await act(async () => {
      vaultEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await act(async () => {
      findButton(container, '选择当前目录')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const updatedText = Array.from(container.querySelectorAll('span')).find(
      (el) => el.getAttribute('aria-label') === '数据根目录',
    );
    expect(updatedText?.textContent).toBe('/data/vault');
    expect(container.textContent).toContain('1 项变更需重启生效');

    await act(async () => {
      findButton(container, '保存到 .env')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/env' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String(patchCall?.[1]?.body));
    expect(body.updates).toEqual([{ name: 'DATA_DIR', value: '/data/vault' }]);
    expect(container.textContent).toContain('已写回 .env，重启后生效');
    expect(onSaved).toHaveBeenCalled();
  });

  it('keeps non-editable vars as plain text display — no disabled dead controls', async () => {
    await renderView([EDITABLE_DIR_VAR, READONLY_VAR]);

    // No input control is rendered for a non-editable var at all.
    expect(container.querySelector('input[aria-label="Kimi 配置"]')).toBeNull();
    const row = Array.from(container.querySelectorAll('.flex.items-start')).find((el) =>
      el.textContent?.includes('Kimi 配置'),
    );
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain('/etc/kimi/config.json');
    // And no disabled control anywhere on the page.
    expect(row?.querySelector(':disabled')).toBeNull();
  });

  it('renders number-control vars as a number input with the placeholder hint', async () => {
    await renderView([NUMBER_VAR]);

    const input = container.querySelector('input[aria-label="消息过期时间"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('number');
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('604800 = 7天');
    expect(input.value).toBe('');
  });

  it('renders security/storage toggles as clickable switches without disabled', async () => {
    await renderView([TOGGLE_VAR]);

    const toggle = container.querySelector('button[role="switch"][aria-label="内存模式（后备）"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('offers the .env escape hatch link at the top of the page', async () => {
    await renderView([EDITABLE_DIR_VAR]);

    const link = Array.from(container.querySelectorAll('button, a')).find(
      (el) => el.textContent?.trim() === '打开 .env ↗',
    );
    expect(link).toBeTruthy();
  });

  it('shows an error strip when the save PATCH fails', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/dir-list?path=%2Fdata' && !init?.method) {
        return Promise.resolve(jsonResponse({ path: '/data', parent: '/', entries: [] }));
      }
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: '保存失败（测试）' }, 500));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await renderView([EDITABLE_DIR_VAR]);

    // Open the modal and re-select the same current dir is a no-op; force a draft
    // change by picking a different directory listing result instead.
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/dir-list?path=%2Fdata' && !init?.method) {
        return Promise.resolve(
          jsonResponse({ path: '/data', parent: '/', entries: [{ name: 'other', path: '/other' }] }),
        );
      }
      if (path === '/api/config/dir-list?path=%2Fother' && !init?.method) {
        return Promise.resolve(jsonResponse({ path: '/other', parent: '/', entries: [] }));
      }
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: '保存失败（测试）' }, 500));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      findButton(container, '修改')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await act(async () => {
      findButton(container, 'other/')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await act(async () => {
      findButton(container, '选择当前目录')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await act(async () => {
      findButton(container, '保存到 .env')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('保存失败（测试）');
  });
});
