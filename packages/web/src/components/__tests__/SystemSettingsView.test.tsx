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
  name: 'API_SERVER_PORT',
  defaultValue: '3004',
  description: 'API 服务端口',
  category: 'server',
  sensitive: false,
  runtimeEditable: false,
  label: 'API 端口',
  settingsGroup: 'network',
  restartRequired: true,
  currentValue: '3002',
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

    const input = container.querySelector('input[aria-label="数据根目录"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('/data');
    const pickButton = findButton(container, '选择…');
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

    expect((container.querySelector('input[aria-label="数据根目录"]') as HTMLInputElement).value).toBe('/data/vault');
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

  it('keeps non-editable vars as disabled/readOnly display', async () => {
    await renderView([EDITABLE_DIR_VAR, READONLY_VAR]);

    const readonlyInput = container.querySelector('input[aria-label="API 端口"]') as HTMLInputElement;
    expect(readonlyInput).toBeTruthy();
    expect(readonlyInput.readOnly).toBe(true);
    expect(readonlyInput.value).toBe('3002');
    // The read-only var's own row has no interactive picker button.
    expect(readonlyInput.closest('.flex.items-start')?.querySelector('button')).toBeNull();
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
      findButton(container, '选择…')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
