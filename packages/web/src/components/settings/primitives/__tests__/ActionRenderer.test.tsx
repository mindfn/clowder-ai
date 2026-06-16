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

  it('persists rollback action when a polling operation times out', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' });
      }
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({ ok: true, render: 'status', label: 'Reset to generate' });
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

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/weixin/actions/connect/qr-generate', {
      method: 'POST',
    });
    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.querySelector('[data-testid="weixin-action-qr-generate"]')).not.toBeNull();
  });
});
