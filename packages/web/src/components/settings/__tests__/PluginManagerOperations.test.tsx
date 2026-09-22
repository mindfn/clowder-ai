import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

const mockApiFetch = vi.mocked(apiFetch);
const plugin = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  id: 'dev.clowder.fixture',
  config: 'incomplete' as const,
  setupSteps: undefined,
  configFields: [
    {
      kind: 'string' as const,
      key: 'account',
      label: 'Account',
      required: false,
      currentValue: null,
      sensitive: false,
    },
    {
      kind: 'operation' as const,
      key: 'qr_login',
      label: 'QR login',
      required: true,
      currentValue: null,
      sensitive: false,
      actions: [
        { id: 'generate', label: 'Generate QR', render: 'button' as const, next: 'connected' },
        { id: 'connected', label: 'Connected', render: 'status' as const },
      ],
    },
  ],
};

async function flushEffects() {
  await act(async () => Promise.resolve());
}

describe('Plugin Manager operation fields', () => {
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
  });

  it('renders an operation action, sends flat drafts, and refreshes its detail', async () => {
    const onOperationChange = vi.fn();
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, render: 'img', data: { url: 'https://example.com/qr.png' } })),
    );
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={plugin}
          busy={false}
          validationRequest={0}
          saved={false}
          onOperationChange={onOperationChange}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="field-qr_login"]')).toBeNull();
    const account = container.querySelector('[data-testid="field-account"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(account, 'alice');
      account.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const action = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Generate QR'),
    );
    await act(async () => action?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/dev.clowder.fixture/actions/qr_login/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'alice' }),
    });
    expect(container.querySelector('[data-testid="dev.clowder.fixture-qr-image"]')).not.toBeNull();
    expect(onOperationChange).toHaveBeenCalledOnce();
  });

  it('excludes required operations from validation and saved updates', async () => {
    const onSaveConfig = vi.fn();
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={plugin}
          busy={false}
          validationRequest={0}
          saved={false}
          onSaveConfig={onSaveConfig}
        />,
      ),
    );
    const account = container.querySelector('[data-testid="field-account"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(account, 'alice');
      account.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存配置');
    await act(async () => save?.click());

    expect(container.textContent).not.toContain('请填写 QR login');
    expect(onSaveConfig).toHaveBeenCalledWith([{ key: 'account', value: 'alice' }]);
  });
});
