import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent, resolvePluginManagerDesignGate } from '../PluginsContent';

const mockApiFetch = vi.mocked(apiFetch);
const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function managerPlugin({ installed = false, revision = 7 } = {}) {
  return {
    pluginId: 'dev.clowder.video-analysis',
    pluginInstanceId: installed ? 'pi_video' : null,
    displayName: 'Video Analysis',
    description: {
      default: 'Analyze remote videos.',
      translations: { 'zh-CN': '分析远程视频。' },
    },
    icon: { type: 'svg', src: '/api/plugin-manager/assets/video/icon.svg' },
    publisher: 'Clowder AI',
    source: {
      kind: 'catalog',
      catalogId: 'dev.clowder.video-analysis',
      packageName: '@clowder-ai/video-analysis',
      trust: 'official',
    },
    availableVersion: '0.1.0-alpha.0',
    installedVersion: installed ? '0.1.0-alpha.0' : null,
    packageDigest: digest,
    artifact: installed ? 'installed' : 'absent',
    config: installed ? 'ready' : 'incomplete',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    lifecycleRevision: installed ? revision : null,
    capabilitySummary: [{ id: 'video-analysis-toolset', kind: 'mcp', name: 'Video analysis', active: false }],
    actions: {
      install: !installed,
      setEnabled: installed,
      uninstall: installed,
      blockingReasons: [],
    },
  } as const;
}

function response(plugin: unknown = managerPlugin()) {
  return {
    plugins: [plugin],
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function detail(plugin = managerPlugin()) {
  return {
    plugin: {
      ...plugin,
      capabilities: plugin.capabilitySummary.map((capability) => ({
        ...capability,
        description: 'Analyze a selected video.',
      })),
      configFields: [],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function configuredDetail(plugin = managerPlugin({ installed: true })) {
  return {
    plugin: {
      ...plugin,
      config: 'incomplete',
      actions: { ...plugin.actions, setEnabled: false, blockingReasons: ['config-incomplete'] },
      capabilities: plugin.capabilitySummary,
      configFields: [
        {
          key: 'apiKey',
          label: 'API key',
          kind: 'secret',
          required: true,
          sensitive: true,
          currentValue: null,
        },
      ],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function connectorPlugin() {
  return {
    ...managerPlugin({ installed: true }),
    pluginId: 'telegram',
    displayName: 'Telegram',
    source: {
      kind: 'compatibility',
      adapter: 'connector',
      packageName: 'connector:telegram',
      trust: 'first-party',
    },
    packageDigest: null,
    pluginInstanceId: null,
    lifecycleRevision: null,
    actions: {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['compatibility-read-only'],
    },
  } as const;
}

function connectorDetail() {
  const plugin = connectorPlugin();
  return {
    plugin: {
      ...plugin,
      capabilities: [],
      configFields: [
        {
          kind: 'secret',
          key: 'TELEGRAM_BOT_TOKEN',
          label: 'Bot token',
          required: true,
          sensitive: true,
          currentValue: null,
        },
      ],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('F202 Plugin Manager surface selection', () => {
  it('keeps the live Manager reachable from the production start:direct build', () => {
    expect(resolvePluginManagerDesignGate('?pluginManagerLive=1', 'production')).toEqual({
      resolved: true,
      enabled: false,
      live: true,
      degradedCatalog: false,
    });
  });

  it('keeps the fixture-only design surface development-only', () => {
    expect(resolvePluginManagerDesignGate('?pluginManagerDemo=1', 'production')).toEqual({
      resolved: true,
      enabled: false,
      live: false,
      degradedCatalog: false,
    });
  });
});

describe('F202 live Plugin Manager Console wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/settings?pluginManagerLive=1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/settings');
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('loads list and detail only from the canonical Manager surface', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') {
        return json({ readmeMarkdown: '# Video Analysis\n\nHuman-facing details.' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('Video Analysis');
    expect(container.textContent).toContain('分析远程视频。');
    expect(container.textContent).toContain('Human-facing details.');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins');
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/official')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/personal-chrome')).toBe(false);
  });

  it('shows an honest loading surface before the first Manager snapshot arrives', async () => {
    mockApiFetch.mockReturnValue(new Promise<Response>(() => {}));

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.querySelector('[data-testid="plugin-manager-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain('没有符合条件的插件');
  });

  it('sends the exact lifecycle revision and refreshes after a stale conflict', async () => {
    const installed = managerPlugin({ installed: true });
    let listReads = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') {
        listReads += 1;
        return json(response(installed));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail(installed));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled' && init?.method === 'POST') {
        return json({ error: 'state changed', code: 'STALE_REVISION' }, 409);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="启用Video Analysis"]');
    await act(async () => (toggle as HTMLButtonElement | null)?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedRevision: 7 }),
    });
    expect(listReads).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('插件状态已变化，已刷新最新状态');
  });

  it('installs the exact catalog release and searches through the canonical endpoint', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/search?q=video') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/install' && init?.method === 'POST') {
        return json({ pluginId: 'dev.clowder.video-analysis', pluginInstanceId: 'pi_video' }, 201);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'video');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/search?q=video');

    const install = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '安装');
    await act(async () => install?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { kind: 'catalog', catalogId: 'dev.clowder.video-analysis' },
        expectedVersion: '0.1.0-alpha.0',
        expectedDigest: digest,
      }),
    });
  });

  it('renders a compatibility configuration contribution and saves through its typed boundary', async () => {
    const plugin = connectorPlugin();
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/telegram') return json(connectorDetail());
      if (url === '/api/connectors/telegram/config' && init?.method === 'PUT') return json({ ok: true });
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const input = container.querySelector('[data-testid="field-TELEGRAM_BOT_TOKEN"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, '123456:secret');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('保存配置'),
    ) as HTMLButtonElement | undefined;
    expect(input?.value).toBe('123456:secret');
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/telegram/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [{ name: 'TELEGRAM_BOT_TOKEN', value: '123456:secret' }] }),
    });
  });

  it('saves Host-managed typed configuration through the contribution route with a revision fence', async () => {
    const plugin = managerPlugin({ installed: true });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(configuredDetail(plugin));
      if (
        url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/configuration' &&
        init?.method === 'POST'
      ) {
        return json({ pluginId: plugin.pluginId, pluginInstanceId: 'pi_video' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const input = container.querySelector('[data-testid="field-apiKey"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, 'private-key');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('保存配置'),
    );
    await act(async () => save?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/configuration',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 7, updates: [{ key: 'apiKey', value: 'private-key' }] }),
      },
    );
  });

  it('polls by replacing the same projection without emitting duplicate UI errors', async () => {
    vi.useFakeTimers();
    let listReads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') {
        listReads += 1;
        return json(response(managerPlugin({ installed: true })));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        return json(detail(managerPlugin({ installed: true })));
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(listReads).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listReads).toBe(2);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-plugin-id="dev.clowder.video-analysis"]')).toHaveLength(1);
  });
});
