import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../HubPermissionsTab', () => ({
  default: () => React.createElement('div', { 'data-testid': 'permissions-mock' }, 'Permissions Mock'),
}));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);
const { HubConnectorConfigTab } = await import('../HubConnectorConfigTab');

const CONNECT_WECHAT_FLOW = {
  id: 'connect-wechat',
  name: '对接微信',
  steps: [{ id: 'expand-wechat', target: 'connector.weixin', tips: '展开微信渠道配置', advance: 'click' as const }],
};

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

async function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    nativeInputValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function feishuStatus(
  fields?: Array<{ envName: string; label: string; sensitive: boolean; currentValue: string | null }>,
) {
  return {
    platforms: [
      {
        id: 'feishu',
        name: '飞书',
        nameEn: 'Feishu / Lark',
        configured: true,
        docsUrl: 'https://open.feishu.cn',
        steps: [{ text: 'step-1' }, { text: 'step-2' }],
        fields: fields ?? [
          { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: 'cli_existing' },
          { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true, currentValue: '••••••••' },
        ],
      },
    ],
  };
}

function platformToggle(container: HTMLElement, platformId: string): HTMLElement | null {
  return container.querySelector(`[data-guide-id="connector.${platformId}"] [role="button"]`);
}

describe('F134 follow-up — HubConnectorConfigTab', () => {
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
    act(() => {
      useGuideStore.getState().exitGuide();
    });
    vi.clearAllMocks();
  });

  it('renders manifest action UI inside expanded Feishu card and refreshes status after action transition', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: false,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              operations: [
                {
                  name: 'connect',
                  label: 'Connect',
                  currentAction: 'start',
                  actions: [
                    { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
                    { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
                  ],
                },
              ],
              fields: [
                { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: null },
                { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true, currentValue: null },
                { envName: 'FEISHU_CONNECTION_MODE', label: '连接模式', sensitive: false, currentValue: 'webhook' },
                {
                  envName: 'FEISHU_VERIFICATION_TOKEN',
                  label: 'Verification Token',
                  sensitive: true,
                  currentValue: null,
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, render: 'status', label: 'Connected' }))
      .mockResolvedValueOnce(
        jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: true,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              operations: [
                {
                  name: 'connect',
                  label: 'Connect',
                  currentAction: 'disconnect',
                  actions: [
                    { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
                    { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
                  ],
                },
              ],
              fields: [],
            },
          ],
        }),
      );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const action = container.querySelector('[data-testid="feishu-action-start"]');
    expect(action).toBeTruthy();

    await act(async () => {
      (action as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(3);
    expect(mockApiFetch.mock.calls[1][0]).toBe('/api/connectors/feishu/actions/connect/start');
  });

  it('does not collapse an expanded weixin card when the current guide step targets connector.weixin', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        platforms: [
          {
            id: 'weixin',
            name: '微信',
            nameEn: 'Weixin',
            configured: false,
            docsUrl: 'https://open.weixin.qq.com',
            steps: [{ text: '生成二维码' }, { text: '完成接入' }],
            fields: [],
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const card = container.querySelector('[data-guide-id="connector.weixin"]');
    const expand = platformToggle(container, 'weixin');
    expect(card).toBeTruthy();
    expect(expand).toBeTruthy();

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(card?.getAttribute('data-active')).toBe('true');

    await act(async () => {
      useGuideStore.getState().startGuide(CONNECT_WECHAT_FLOW);
      useGuideStore.getState().setPhase('active');
    });

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(card?.getAttribute('data-active')).toBe('true');
  });

  it('saves only touched fields and does not submit masked secret placeholders', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(feishuStatus())).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const appId = container.querySelector('[data-testid="field-FEISHU_APP_ID"]') as HTMLInputElement;
    await setInputValue(appId, 'cli_new');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(3);
    const saveCall = mockApiFetch.mock.calls[1];
    expect(saveCall[0]).toBe('/api/connectors/feishu/config');
    expect(JSON.parse((saveCall[1] as RequestInit).body as string)).toEqual({
      fields: [{ name: 'FEISHU_APP_ID', value: 'cli_new' }],
    });
  });

  it('blocks user-entered redacted placeholders before calling the secrets API', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(feishuStatus()));

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const secret = container.querySelector('[data-testid="field-FEISHU_APP_SECRET"]') as HTMLInputElement;
    await setInputValue(secret, '••••••');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="save-result"]')?.textContent).toContain('脱敏占位符');
  });

  it('renders connector write auth errors from the secrets API', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse(feishuStatus()))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Connector credential writes can only be modified by the configured owner' }, 403),
      );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const appId = container.querySelector('[data-testid="field-FEISHU_APP_ID"]') as HTMLInputElement;
    await setInputValue(appId, 'cli_new');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="save-result"]')?.textContent).toContain('configured owner');
  });

  it('renders manifest operations even when a connector has only one setup step', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        platforms: [
          {
            id: 'single-step-plugin',
            name: 'Single Step Plugin',
            nameEn: 'Single Step Plugin',
            source: 'external',
            configured: false,
            docsUrl: '',
            steps: [{ text: 'Install plugin' }],
            fields: [],
            themeColor: '#00AAFF',
            operations: [
              {
                name: 'connect',
                label: 'Connect',
                currentAction: 'connect',
                actions: [{ id: 'connect', label: 'Connect plugin', render: 'button' }],
              },
            ],
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const card = container.querySelector('[data-guide-id="connector.single-step-plugin"]');
    const expand = card?.querySelector('[role="button"]');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="single-step-plugin-action-connect"]')).toBeTruthy();
  });
});
