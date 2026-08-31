import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubEnvFilesTab } from '@/components/HubEnvFilesTab';

const mockApiFetch = vi.mocked(apiFetch);

const MOCK_ENV_SUMMARY = {
  categories: { server: '服务器', storage: '存储', evidence: '证据' },
  variables: [
    // System vars: surfaced by ?surface=system and filtered from the generic dump.
    {
      name: 'API_SERVER_PORT',
      defaultValue: '3004',
      description: 'API 服务端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      currentValue: '3002',
    },
    {
      name: 'PREVIEW_GATEWAY_PORT',
      defaultValue: '4100',
      description: 'Preview Gateway 端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      currentValue: '4100',
    },
    {
      name: 'FRONTEND_URL',
      defaultValue: '(自动检测)',
      description: '前端 URL（导出长图用）',
      category: 'server',
      sensitive: false,
      runtimeEditable: true,
      currentValue: 'http://localhost:3004',
    },
    {
      name: 'REDIS_URL',
      defaultValue: '(未设置)',
      description: 'Redis 连接地址',
      category: 'storage',
      sensitive: false,
      maskMode: 'url',
      runtimeEditable: false,
      currentValue: 'redis://***@localhost:6379/15',
    },
    // Denylisted vars: already covered by module UI and filtered from the dump.
    {
      name: 'OPENAI_API_KEY',
      defaultValue: '(未设置)',
      description: 'OpenAI API Key',
      category: 'server',
      sensitive: true,
      currentValue: '***',
    },
    {
      name: 'F102_API_KEY',
      defaultValue: '(未设置)',
      description: 'F102 summarizer API key',
      category: 'evidence',
      sensitive: true,
      runtimeEditable: true,
      targetWritePolicy: 'read-only-opt-in',
      currentValue: '***',
    },
    // A non-system, non-denylisted editable var that should remain in the dump.
    {
      name: 'DEMO_SERVER_ENDPOINT',
      defaultValue: 'http://localhost:5000',
      description: '测试用可编辑服务端点',
      category: 'server',
      sensitive: false,
      runtimeEditable: true,
      currentValue: 'http://localhost:5000',
    },
  ],
  paths: {
    projectRoot: '/tmp/project',
    homeDir: '/tmp/home',
    dataDirs: {
      auditLogs: '/tmp/project/data/audit-logs',
      runtimeLogs: '/tmp/project/data/runtime-logs',
      cliArchive: '/tmp/project/data/cli-raw-archive',
      redisDevSandbox: '/tmp/home/.cat-cafe/redis-dev-sandbox',
      uploads: '/tmp/project/uploads',
    },
  },
};

const MOCK_SYSTEM_ENV_SUMMARY = {
  variables: [
    {
      name: 'API_SERVER_PORT',
      defaultValue: '3004',
      description: 'API 服务端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      currentValue: '3002',
    },
    {
      name: 'PREVIEW_GATEWAY_PORT',
      defaultValue: '4100',
      description: 'Preview Gateway 端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      currentValue: '4100',
    },
    {
      name: 'FRONTEND_URL',
      defaultValue: '(自动检测)',
      description: '前端 URL（导出长图用）',
      category: 'server',
      sensitive: false,
      runtimeEditable: true,
      currentValue: 'http://localhost:3004',
    },
    {
      name: 'REDIS_URL',
      defaultValue: '(未设置)',
      description: 'Redis 连接地址',
      category: 'storage',
      sensitive: false,
      maskMode: 'url',
      runtimeEditable: false,
      currentValue: 'redis://***@localhost:6379/15',
    },
  ],
};

const MOCK_SYSTEM_STATUS_REDIS = {
  storageMode: 'redis',
  storage: {
    mode: 'redis',
    persistent: true,
    warning: null,
  },
};

const MOCK_SYSTEM_STATUS_MEMORY = {
  storageMode: 'memory',
  storage: {
    mode: 'memory',
    persistent: false,
    warning: 'Memory mode: data will be lost on restart.',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultEnvApiFetch(path: string, init?: RequestInit) {
  if (path === '/api/config/env-summary' && !init?.method) {
    return Promise.resolve(jsonResponse(MOCK_ENV_SUMMARY));
  }
  if (path === '/api/config/env-summary?surface=system' && !init?.method) {
    return Promise.resolve(jsonResponse(MOCK_SYSTEM_ENV_SUMMARY));
  }
  if (path === '/api/system/status' && !init?.method) {
    return Promise.resolve(jsonResponse(MOCK_SYSTEM_STATUS_REDIS));
  }
  if (path === '/api/config/env' && init?.method === 'PATCH') {
    return Promise.resolve(jsonResponse({ ok: true }));
  }
  throw new Error(`Unexpected apiFetch path: ${path}`);
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeField(element: HTMLInputElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('HubEnvFilesTab', () => {
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
    mockApiFetch.mockImplementation(defaultEnvApiFetch);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders persistent Redis storage mode as a subtle healthy status', async () => {
    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/system/status');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/config/env-summary?surface=system');
    expect(container.textContent).toContain('Redis persistent mode');
    expect(container.textContent).not.toContain('Memory mode — data will be lost on restart');
  });

  it('renders memory storage mode as a visible data-loss warning', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/system/status' && !init?.method) {
        return Promise.resolve(jsonResponse(MOCK_SYSTEM_STATUS_MEMORY));
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('Memory mode — data will be lost on restart');
    expect(container.textContent).not.toContain('Redis persistent mode');
  });

  it('renders editable env vars, keeps credentials masked, and saves back to .env', async () => {
    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    const sectionTitles = Array.from(container.querySelectorAll('h3')).map((node) => node.textContent?.trim());
    expect(sectionTitles.slice(0, 3)).toEqual(['环境变量', '配置文件', '数据目录']);
    expect(container.textContent).toContain('cat-template.json');
    expect(container.textContent).toContain('.cat-cafe/cat-catalog.json');
    expect(container.textContent).toContain('当前环境变量、配置文件、数据目录三段式不变');
    expect(container.textContent).toContain('变量值可直接编辑，保存后自动回填 .env');
    expect(container.textContent).toContain('URL 型连接串当前值已脱敏');

    // System vars are surfaced on the System tab, not here.
    expect(container.querySelector('input[aria-label="API_SERVER_PORT"]')).toBeNull();
    expect(container.querySelector('input[aria-label="PREVIEW_GATEWAY_PORT"]')).toBeNull();
    expect(container.querySelector('input[aria-label="FRONTEND_URL"]')).toBeNull();
    expect(container.querySelector('input[aria-label="REDIS_URL"]')).toBeNull();
    // Vars with dedicated module UI are filtered from the generic dump.
    expect(container.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull();
    expect(container.querySelector('input[aria-label="F102_API_KEY"]')).toBeNull();

    const demoInput = container.querySelector('input[aria-label="DEMO_SERVER_ENDPOINT"]') as HTMLInputElement;
    expect(demoInput).toBeTruthy();
    await changeField(demoInput, 'http://localhost:3200');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存到 .env',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/env' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect(String(patchCall?.[1]?.body)).not.toContain('API_SERVER_PORT');
    expect(String(patchCall?.[1]?.body)).not.toContain('PREVIEW_GATEWAY_PORT');
    expect(String(patchCall?.[1]?.body)).not.toContain('FRONTEND_URL');
    expect(String(patchCall?.[1]?.body)).not.toContain('REDIS_URL');
    expect(String(patchCall?.[1]?.body)).not.toContain('OPENAI_API_KEY');
    expect(String(patchCall?.[1]?.body)).not.toContain('F102_API_KEY');
    expect(String(patchCall?.[1]?.body)).toContain('DEMO_SERVER_ENDPOINT');
    expect(String(patchCall?.[1]?.body)).toContain('http://localhost:3200');
    expect(container.textContent).toContain('已写回 .env 并刷新摘要；部分变量需重启相关服务生效');
  });

  it('shows a save error when /api/config/env PATCH fails', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: '保存失败（测试）' }, 500));
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    await changeField(
      container.querySelector('input[aria-label="DEMO_SERVER_ENDPOINT"]') as HTMLInputElement,
      'http://localhost:3200',
    );

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存到 .env',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('保存失败（测试）');
  });

  it('does not render denylisted vars in the generic env dump', async () => {
    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    expect(container.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull();
    expect(container.querySelector('input[aria-label="F102_API_KEY"]')).toBeNull();
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
    expect(container.textContent).not.toContain('F102_API_KEY');
  });

  it('serializes save requests when 保存到 .env is double-clicked', async () => {
    let resolvePatch!: (value: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return patchPromise;
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    await changeField(
      container.querySelector('input[aria-label="DEMO_SERVER_ENDPOINT"]') as HTMLInputElement,
      'http://localhost:3200',
    );
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存到 .env',
    );

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      mockApiFetch.mock.calls.filter(([path, init]) => path === '/api/config/env' && init?.method === 'PATCH'),
    ).toHaveLength(1);

    resolvePatch(jsonResponse({ ok: true }));
    await flushEffects();
  });
});
