/**
 * F770 Gate 2: the curated system settings view (6 status facts + 5 decisions).
 *
 * Guards opus's three review points:
 *   ① 「（重启生效）」appears ONLY on decisions ①② (data dir, LAN access)
 *   ② the one-line small print states the current fact (LAN reachability,
 *     retention applies to new data only, platform defaults always enforced)
 *   ③ no env var names in user-facing text; decisions ③④⑤ call the dedicated
 *     JSON routes, never the generic PATCH /api/config/env
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import type { EnvVar } from '@/components/settings/EnvSubComponents';
import { SystemSettingsGate2 } from '@/components/settings/SystemSettingsGate2';

const mockApiFetch = vi.mocked(apiFetch);

function envVar(partial: Partial<EnvVar> & { name: string; currentValue: string | null }): EnvVar {
  return {
    defaultValue: '',
    description: '',
    category: 'server',
    sensitive: false,
    ...partial,
  };
}

const VARIABLES: EnvVar[] = [
  envVar({
    name: 'DATA_DIR',
    currentValue: '/data',
    label: '数据根目录',
    restartRequired: true,
    runtimeEditable: true,
  }),
  envVar({
    name: 'API_SERVER_HOST',
    currentValue: '127.0.0.1',
    label: '监听地址',
    restartRequired: true,
    runtimeEditable: true,
  }),
  envVar({ name: 'API_SERVER_PORT', currentValue: '3001', label: 'API 端口', restartRequired: true }),
  envVar({
    name: 'CORS_ALLOW_PRIVATE_NETWORK',
    currentValue: 'false',
    label: '允许局域网访问',
    restartRequired: true,
    runtimeEditable: true,
  }),
  envVar({ name: 'REDIS_URL', currentValue: 'redis://127.0.0.1:6379', label: '数据库连接', restartRequired: true }),
  envVar({ name: 'DEFAULT_OWNER_USER_ID', currentValue: '', label: '所有者用户 ID', restartRequired: true }),
  envVar({
    name: 'CAT_CAFE_DATA_DIR',
    currentValue: '/home/user/.cat-cafe',
    label: '平台数据目录',
    restartRequired: true,
  }),
  envVar({ name: 'MEMORY_STORE', currentValue: null, label: '内存模式（后备）', restartRequired: true }),
];

const ENV_VAR_NAMES = [
  'DATA_DIR',
  'API_SERVER_HOST',
  'API_SERVER_PORT',
  'CORS_ALLOW_PRIVATE_NETWORK',
  'REDIS_URL',
  'MEMORY_STORE',
  'DEFAULT_OWNER_USER_ID',
  'CAT_CAFE_DATA_DIR',
  'LOG_LEVEL',
  'PROJECT_DENIED_ROOTS',
  'MESSAGE_TTL_SECONDS',
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultMock(path: string, init?: RequestInit): Promise<Response> {
  if (path === '/api/config/retention' && !init?.method) {
    return Promise.resolve(
      jsonResponse({
        config: { message: 0, thread: 0, task: 0, summary: 0, backlog: 0 },
        sources: { message: 'default', thread: 'default', task: 'default', summary: 'default', backlog: 'default' },
        draftTtlSeconds: 300,
      }),
    );
  }
  if (path === '/api/config/log-level' && !init?.method) {
    return Promise.resolve(
      jsonResponse({ logLevel: null, source: 'none', migratedFromEnv: false, effectiveLevel: 'info' }),
    );
  }
  if (path === '/api/config/denied-roots' && !init?.method) {
    return Promise.resolve(
      jsonResponse({ deniedRoots: [], source: 'none', migratedFromEnv: false, platformDefaults: true }),
    );
  }
  if (path === '/api/config/env' && init?.method === 'PATCH') {
    return Promise.resolve(jsonResponse({ ok: true }));
  }
  return Promise.resolve(jsonResponse({}, 404));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
}

function callsTo(method: string, url: string): Array<{ path: string; init?: RequestInit }> {
  return mockApiFetch.mock.calls
    .filter(([path, init]) => path === url && (init as RequestInit | undefined)?.method === method)
    .map(([path, init]) => ({ path: path as string, init: init as RequestInit | undefined }));
}

describe('SystemSettingsGate2', () => {
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
    mockApiFetch.mockImplementation(defaultMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderView(variables: EnvVar[] = VARIABLES) {
    await act(async () => {
      root.render(React.createElement(SystemSettingsGate2, { variables }));
    });
    await flushEffects();
  }

  it('shows status facts and five decisions; the restart marker appears only on ①②', async () => {
    await renderView();
    const text = container.textContent ?? '';

    // Status facts
    expect(text).toContain('存储模式');
    expect(text).toContain('持久化（Redis）');
    expect(text).toContain('数据存在哪');
    expect(text).toContain('/data');
    expect(text).toContain('当前访问地址与端口');
    expect(text).toContain('http://127.0.0.1:3001');
    expect(text).toContain('所有者模式');
    expect(text).toContain('单用户本地');
    expect(text).toContain('平台状态目录');

    // Five decisions
    expect(text).toContain('数据存放位置');
    expect(text).toContain('允许局域网访问');
    expect(text).toContain('数据保留');
    expect(text).toContain('日志详细程度');
    expect(text).toContain('禁止访问目录');

    // ① restart marker only on ①②
    const markerCount = text.split('（重启生效）').length - 1;
    expect(markerCount).toBe(2);

    // ③ no env var names in user-facing text
    for (const name of ENV_VAR_NAMES) {
      expect(text).not.toContain(name);
    }
  });

  it('warns when running in memory mode', async () => {
    await renderView(
      VARIABLES.map((variable) => (variable.name === 'REDIS_URL' ? { ...variable, currentValue: null } : variable)),
    );
    expect(container.textContent).toContain('内存模式');
    expect(container.textContent).toContain('重启后数据不会保留');
  });

  it('LAN toggle writes both env vars together and the small print states the fact', async () => {
    await renderView();
    expect(container.textContent).toContain('仅本地可以访问');

    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patches = callsTo('PATCH', '/api/config/env');
    expect(patches).toHaveLength(1);
    const body = JSON.parse((patches[0].init?.body as string) ?? '{}') as {
      updates: Array<{ name: string; value: string }>;
    };
    const byName = new Map(body.updates.map((update) => [update.name, update.value]));
    // The pair must never drift apart: host binding AND the CORS flag in one write.
    expect(byName.get('API_SERVER_HOST')).toBe('0.0.0.0');
    expect(byName.get('CORS_ALLOW_PRIVATE_NETWORK')).toBe('true');

    // Small print flipped to the current fact, and neither JSON route was touched.
    expect(container.textContent).toContain('可被同一局域网中的任意设备访问');
    expect(callsTo('PUT', '/api/config/retention')).toHaveLength(0);
    expect(callsTo('PUT', '/api/config/log-level')).toHaveLength(0);
    expect(callsTo('PUT', '/api/config/denied-roots')).toHaveLength(0);
  });

  it('retention presets PUT seconds to the dedicated route, never PATCH env', async () => {
    await renderView();
    const select = Array.from(container.querySelectorAll('select')).find(
      (element) => element.getAttribute('aria-label') === '数据保留',
    );
    expect(select).toBeTruthy();

    setNativeValue(select!, '6mo');
    await act(async () => {
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const puts = callsTo('PUT', '/api/config/retention');
    expect(puts).toHaveLength(1);
    const body = JSON.parse((puts[0].init?.body as string) ?? '{}') as Record<string, number>;
    expect(body).toEqual({
      message: 15552000,
      thread: 15552000,
      task: 15552000,
      summary: 15552000,
      backlog: 15552000,
    });
    expect(callsTo('PATCH', '/api/config/env')).toHaveLength(0);
    expect(container.textContent).toContain('只对新数据生效');
    expect(container.textContent).toContain('草稿保存 5 分钟后自动清除');
  });

  it('log level PUTs the dedicated route', async () => {
    await renderView();
    const select = Array.from(container.querySelectorAll('select')).find(
      (element) => element.getAttribute('aria-label') === '日志详细程度',
    );
    expect(select).toBeTruthy();
    expect(select!.value).toBe('info'); // stored null → honest effective level, not the first option

    setNativeValue(select!, 'debug');
    await act(async () => {
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushEffects();

    const puts = callsTo('PUT', '/api/config/log-level');
    expect(puts).toHaveLength(1);
    expect(JSON.parse((puts[0].init?.body as string) ?? '{}')).toEqual({ logLevel: 'debug' });
    expect(callsTo('PATCH', '/api/config/env')).toHaveLength(0);
  });

  it('denied roots: relative path rejected, absolute path PUT to the dedicated route', async () => {
    await renderView();
    const input = container.querySelector('input[aria-label="添加禁止访问目录"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const addButton = findButton(container, '添加');
    expect(addButton).toBeTruthy();

    setNativeValue(input!, 'relative/path');
    await act(async () => {
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(callsTo('PUT', '/api/config/denied-roots')).toHaveLength(0);
    expect(container.textContent).toContain('需要绝对路径');

    setNativeValue(input!, '/private/tmp');
    await act(async () => {
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const puts = callsTo('PUT', '/api/config/denied-roots');
    expect(puts).toHaveLength(1);
    expect(JSON.parse((puts[0].init?.body as string) ?? '{}')).toEqual({ deniedRoots: ['/private/tmp'] });
    expect(container.textContent).toContain('平台默认的系统目录始终会被拦截');
    expect(callsTo('PATCH', '/api/config/env')).toHaveLength(0);
  });

  it('lists pending-restart items as saved vs current facts', async () => {
    await renderView(
      VARIABLES.map((variable) =>
        variable.name === 'API_SERVER_PORT' ? { ...variable, savedValue: '3002', currentValue: '3001' } : variable,
      ),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('待重启');
    expect(text).toContain('已保存 3002，当前生效 3001');
  });
});
