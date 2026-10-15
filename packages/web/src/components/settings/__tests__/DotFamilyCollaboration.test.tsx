import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { DotConnectionDetail } from '../plugin-manager/DotConnectionDetail';

const mockApiFetch = vi.mocked(apiFetch);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('dot family collaboration settings', () => {
  let container: HTMLDivElement, root: Root;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('shows connected collaboration without a second housecat permission step or roster dependency', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/chatgpt-dot/connection')
        return json({
          installed: true,
          paired: true,
          subscription: 'active',
          revoked: false,
          replyAt: Date.now(),
          imageAt: null,
          endpointUrl: null,
          allowedCatIds: [],
        });
      if (url === '/api/plugins/chatgpt-dot/test') return json({ tests: [] });
      return json({}, 503);
    });
    await act(async () => root.render(<DotConnectionDetail installed />));
    await flushEffects();
    expect(container.textContent).toContain('收到过真实回复');
    expect(container.textContent).not.toContain('获准召唤的家猫');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/cats')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
