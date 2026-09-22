import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { ActionRenderer } from '../ActionRenderer';

const mockApiFetch = vi.mocked(apiFetch);

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ActionRenderer plugin target', () => {
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
  });

  it('polls and resets through package operation endpoints', async () => {
    const onStatusChange = vi.fn();
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/actions/qr_login/generate')) {
        return new Response(JSON.stringify({ ok: true, render: 'img', data: { url: 'https://example.com/qr.png' } }));
      }
      if (path.endsWith('/actions/qr_login/status')) {
        return new Response(JSON.stringify({ ok: true, render: 'polling', data: { waiting: true } }));
      }
      if (path.endsWith('/operations/qr_login/reset')) return new Response(JSON.stringify({ ok: true }));
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    });

    await act(async () =>
      root.render(
        <ActionRenderer
          target={{ kind: 'plugin', id: 'dev.clowder.fixture' }}
          operation={{
            name: 'qr_login',
            label: 'QR login',
            actions: [
              { id: 'generate', label: 'Generate QR', render: 'button', next: 'status' },
              { id: 'status', label: 'Waiting', render: 'polling', rollback: 'generate', timeout: 1 },
            ],
          }}
          onStatusChange={onStatusChange}
        />,
      ),
    );
    const action = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Generate QR'),
    );
    await act(async () => action?.click());
    await flushEffects();
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/dev.clowder.fixture/actions/qr_login/status', {
      method: 'POST',
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/dev.clowder.fixture/operations/qr_login/reset', {
      method: 'POST',
    });
    expect(onStatusChange).toHaveBeenCalledOnce();
  });
});
