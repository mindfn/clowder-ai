import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);
const { ActionRenderer } = await import('../ActionRenderer');

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

describe('ActionRenderer', () => {
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
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('resets rollback state without executing the rollback action when a polling operation times out', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' });
      }
      if (path.endsWith('/operations/connect/reset')) {
        return jsonResponse({ ok: true, currentAction: 'qr-generate' });
      }
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({ ok: false, label: 'qr-generate should not run during timeout reset' }, 500);
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'qr-status',
            lastResult: { render: 'img', data: { url: 'https://example.com/qr.png' }, label: 'Scan QR' },
            actions: [
              { id: 'qr-generate', label: 'Generate QR Code', render: 'button', next: 'qr-status' },
              { id: 'qr-status', label: 'Waiting', render: 'polling', rollback: 'qr-generate', timeout: 1 },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/weixin/operations/connect/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentAction: 'qr-generate' }),
    });
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/connectors/weixin/actions/connect/qr-generate', {
      method: 'POST',
    });
    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.querySelector('[data-testid="weixin-action-qr-generate"]')).not.toBeNull();
  });

  it('resets immediately when restored polling state is already past its persisted deadline', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/operations/connect/reset')) {
        return jsonResponse({ ok: true, currentAction: 'qr-generate' });
      }
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' });
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'qr-status',
            updatedAt: now.getTime() - 1500,
            lastResult: { render: 'img', data: { url: 'https://example.com/qr.png' }, label: 'Scan QR' },
            actions: [
              { id: 'qr-generate', label: 'Generate QR Code', render: 'button', next: 'qr-status' },
              { id: 'qr-status', label: 'Waiting', render: 'polling', rollback: 'qr-generate', timeout: 1 },
            ],
          },
        }),
      );
    });
    await flushEffects();
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/weixin/operations/connect/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentAction: 'qr-generate' }),
    });
    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.querySelector('[data-testid="weixin-action-qr-generate"]')).not.toBeNull();
  });

  it('passes pending config values when executing connector actions', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true, render: 'status', label: 'Connected' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'wecom-bot',
          pendingConfigValues: {
            WECOM_BOT_ID: 'bot-id-from-form',
            WECOM_BOT_SECRET: 'secret-from-form',
          },
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'validate',
            actions: [{ id: 'validate', label: '测试并连接', render: 'button' }],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wecom-bot-action-validate"]')?.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/wecom-bot/actions/connect/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          WECOM_BOT_ID: 'bot-id-from-form',
          WECOM_BOT_SECRET: 'secret-from-form',
        },
      }),
    });
  });
});
