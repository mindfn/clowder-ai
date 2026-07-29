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
  categories: { server: '服务器', storage: '存储' },
  variables: [
    {
      name: 'API_SERVER_PORT',
      defaultValue: '3004',
      description: 'API 服务端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      label: 'API 端口',
      settingsGroup: 'network',
      currentValue: '3002',
    },
    {
      name: 'PREVIEW_GATEWAY_PORT',
      defaultValue: '4100',
      description: 'Preview Gateway 端口',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      label: 'Preview Gateway 端口',
      settingsGroup: 'network',
      currentValue: '4100',
    },
    {
      name: 'FRONTEND_URL',
      defaultValue: '(自动检测)',
      description: '有反向代理或固定域名时设置',
      category: 'server',
      sensitive: false,
      runtimeEditable: true,
      restartRequired: true,
      label: '前端地址',
      settingsGroup: 'network',
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
      label: 'Redis 连接',
      settingsGroup: 'storage',
      currentValue: 'redis://***@localhost:6379/15',
    },
    {
      name: 'PREVIEW_GATEWAY_ENABLED',
      defaultValue: '1（启用）',
      description: 'F120 独立 origin 反向代理',
      category: 'server',
      sensitive: false,
      runtimeEditable: false,
      label: 'Preview Gateway',
      settingsGroup: 'network',
      booleanSemantics: { defaultOn: true },
      currentValue: null,
    },
    {
      name: 'OPENAI_API_KEY',
      defaultValue: '(未设置)',
      description: 'OpenAI API Key',
      category: 'server',
      sensitive: true,
      currentValue: '***',
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

/** Mock env-summary filtered to system vars (simulates ?surface=system backend filter). */
const MOCK_SYSTEM_ENV_SUMMARY = {
  ...MOCK_ENV_SUMMARY,
  variables: MOCK_ENV_SUMMARY.variables.filter((v) => v.name !== 'OPENAI_API_KEY'),
};

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
    expect(container.querySelector('input[aria-label="API_SERVER_PORT"]')).toBeNull();
    expect(container.querySelector('input[aria-label="PREVIEW_GATEWAY_PORT"]')).toBeNull();
    expect(container.querySelector('input[aria-label="FRONTEND_URL"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="REDIS_URL"]')).toBeNull();
    expect(container.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull();
    expect(container.textContent).toContain('***');

    const frontendUrlInput = container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement;
    await changeField(frontendUrlInput, 'http://localhost:3200');

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
    expect(String(patchCall?.[1]?.body)).toContain('FRONTEND_URL');
    expect(String(patchCall?.[1]?.body)).toContain('http://localhost:3200');
    expect(String(patchCall?.[1]?.body)).not.toContain('REDIS_URL');
    expect(String(patchCall?.[1]?.body)).not.toContain('OPENAI_API_KEY');
    expect(container.textContent).toContain('已写回 .env 并刷新摘要；部分变量需重启相关服务生效');
  });

  it('filters the System surface to explicit system env vars (Codex-style groups)', async () => {
    await act(async () => {
      root.render(<HubEnvFilesTab surface="system" />);
    });
    await flushEffects();

    // System surface uses SystemSettingsView — shows human-readable labels, not env var names
    expect(container.textContent).toContain('前端地址');
    expect(container.textContent).toContain('Redis 连接');
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
    // Group headers present
    expect(container.textContent).toContain('网络 & 端口');
    expect(container.textContent).toContain('存储');
    // Editable input still uses env var name as aria-label
    expect(container.querySelector('input[aria-label="FRONTEND_URL"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull();
  });

  it('#770 P2 regression: unified parseBoolEnv drives toggle for all boolean vars', async () => {
    // Unified rule: '1' or 'true' (case-insensitive) = on, everything else = off.
    // defaultOn governs unset (null) state.
    const booleanTestCases: Array<{
      name: string;
      label: string;
      defaultOn: boolean;
      currentValue: string | null;
      expectedOn: boolean;
      reason: string;
    }> = [
      // --- defaultOn=true (e.g. PREVIEW_GATEWAY_ENABLED) ---
      {
        name: 'DEF_ON_UNSET',
        label: 'def-on unset',
        defaultOn: true,
        currentValue: null,
        expectedOn: true,
        reason: 'unset → defaultOn=true',
      },
      {
        name: 'DEF_ON_ONE',
        label: 'def-on 1',
        defaultOn: true,
        currentValue: '1',
        expectedOn: true,
        reason: "'1' → on",
      },
      {
        name: 'DEF_ON_TRUE',
        label: 'def-on true',
        defaultOn: true,
        currentValue: 'true',
        expectedOn: true,
        reason: "'true' → on",
      },
      {
        name: 'DEF_ON_FALSE',
        label: 'def-on false',
        defaultOn: true,
        currentValue: 'false',
        expectedOn: false,
        reason: "'false' → off",
      },
      {
        name: 'DEF_ON_ZERO',
        label: 'def-on 0',
        defaultOn: true,
        currentValue: '0',
        expectedOn: false,
        reason: "'0' → off",
      },
      // --- defaultOn=false (e.g. CORS, MEMORY_STORE, QUOTA) ---
      {
        name: 'DEF_OFF_UNSET',
        label: 'def-off unset',
        defaultOn: false,
        currentValue: null,
        expectedOn: false,
        reason: 'unset → defaultOn=false',
      },
      {
        name: 'DEF_OFF_ONE',
        label: 'def-off 1',
        defaultOn: false,
        currentValue: '1',
        expectedOn: true,
        reason: "'1' → on",
      },
      {
        name: 'DEF_OFF_TRUE',
        label: 'def-off true',
        defaultOn: false,
        currentValue: 'true',
        expectedOn: true,
        reason: "'true' → on",
      },
      {
        name: 'DEF_OFF_TRUE_CI',
        label: 'def-off TRUE',
        defaultOn: false,
        currentValue: 'TRUE',
        expectedOn: true,
        reason: "'TRUE' ci → on",
      },
      {
        name: 'DEF_OFF_FALSE',
        label: 'def-off false',
        defaultOn: false,
        currentValue: 'false',
        expectedOn: false,
        reason: "'false' → off",
      },
      {
        name: 'DEF_OFF_ZERO',
        label: 'def-off 0',
        defaultOn: false,
        currentValue: '0',
        expectedOn: false,
        reason: "'0' → off",
      },
      {
        name: 'DEF_OFF_RANDOM',
        label: 'def-off random',
        defaultOn: false,
        currentValue: 'yes',
        expectedOn: false,
        reason: "'yes' → off (not '1' or 'true')",
      },
    ];

    const testVars = booleanTestCases.map((tc) => ({
      name: tc.name,
      defaultValue: '(test)',
      description: tc.reason,
      category: 'server' as const,
      sensitive: false,
      runtimeEditable: false,
      label: tc.label,
      settingsGroup: 'network',
      booleanSemantics: { defaultOn: tc.defaultOn },
      currentValue: tc.currentValue,
    }));
    const testSummary = { ...MOCK_ENV_SUMMARY, variables: testVars };
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env-summary?surface=system' && !init?.method) {
        return Promise.resolve(jsonResponse(testSummary));
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(<HubEnvFilesTab surface="system" />);
    });
    await flushEffects();

    for (const tc of booleanTestCases) {
      const toggle = container.querySelector(`[role="switch"][aria-label="${tc.label}"]`);
      expect(toggle, `toggle for ${tc.name} should exist`).toBeTruthy();
      expect(toggle?.getAttribute('aria-checked'), `${tc.name}: ${tc.reason}`).toBe(String(tc.expectedOn));
    }
  });

  it('#770 P1 regression: System surface is preserved after save (no non-system vars leak)', async () => {
    // PATCH returns the FULL unfiltered summary — this is the real API behavior.
    // Before #770 P1 fix, frontend blindly used body.summary, replacing the
    // filtered System list with all hub-visible vars.
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true, summary: MOCK_ENV_SUMMARY.variables }));
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(<HubEnvFilesTab surface="system" />);
    });
    await flushEffects();

    // Precondition: system surface excludes OPENAI_API_KEY, shows labels
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
    expect(container.textContent).toContain('前端地址');

    // Edit a system var and save
    await changeField(
      container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement,
      'http://localhost:3200',
    );
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存到 .env',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // After save, system surface must still exclude non-system vars
    expect(container.textContent).not.toContain('OPENAI_API_KEY');
    // Verify the re-fetch used the correct surface parameter
    const surfaceFetches = mockApiFetch.mock.calls.filter(
      ([path]) => path === '/api/config/env-summary?surface=system',
    );
    // Initial load + post-save re-fetch = 2 calls
    expect(surfaceFetches.length).toBeGreaterThanOrEqual(2);
    // Save success message still shows
    expect(container.textContent).toContain('已写回 .env 并刷新摘要');
  });

  it('treats post-save refresh rejection as a successful save (no false failure)', async () => {
    // PATCH succeeds (.env already written) but the follow-up summary refresh
    // rejects (e.g. transient network interruption). The UI must NOT report
    // 保存失败 — it must keep the successful-save status via the same
    // optimistic fallback used for non-OK refresh responses.
    let initialSummaryServed = false;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/config/env-summary?surface=system' && !init?.method) {
        if (initialSummaryServed) {
          return Promise.reject(new TypeError('network down'));
        }
        initialSummaryServed = true;
        return Promise.resolve(jsonResponse(MOCK_SYSTEM_ENV_SUMMARY));
      }
      return defaultEnvApiFetch(path, init);
    });

    await act(async () => {
      root.render(<HubEnvFilesTab surface="system" />);
    });
    await flushEffects();

    await changeField(
      container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement,
      'http://localhost:3200',
    );
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存到 .env',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // The write DID succeed — no false failure, success status preserved.
    expect(container.textContent).not.toContain('保存失败');
    expect(container.textContent).toContain('已写回 .env');
    // Optimistic fallback applied the saved value locally (draft no longer dirty).
    const input = container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement;
    expect(input.value).toBe('http://localhost:3200');
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
      container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement,
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
      container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement,
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
