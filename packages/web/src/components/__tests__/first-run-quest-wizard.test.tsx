import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: () => Promise.resolve([]),
  }),
}));

import { FirstRunQuestWizard } from '@/components/FirstRunQuestWizard';

const mockApiFetch = vi.mocked(apiFetch);

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

function WizardHost({ onCreated }: { onCreated?: (tid: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <FirstRunQuestWizard
      open={open}
      onClose={() => setOpen(false)}
      onCreated={onCreated ?? (() => {})}
    />
  );
}

describe('FirstRunQuestWizard', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it('renders template step on open and loads templates', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/api/cat-templates')) {
        return jsonResponse({
          templates: [
            {
              id: 'opus',
              displayName: '布偶猫',
              nickname: '宪宪',
              avatar: '/avatars/opus.png',
              color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
              roleDescription: '主架构师',
              personality: '温柔但有主见',
              provider: 'anthropic',
              defaultModel: 'claude-opus-4-6',
              source: 'template',
            },
          ],
        });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('选择角色模板');
    expect(container.textContent).toContain('布偶猫');
    expect(container.textContent).toContain('宪宪');
  });

  it('shows step title for template step', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ templates: [] }));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('第 1 步');
    expect(container.textContent).toContain('选择角色模板');
  });

  it('shows empty state when no templates available', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ templates: [] }));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('暂无可用角色模板');
  });

  it('handles template API errors gracefully', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    // Should degrade gracefully, not crash
    expect(container.textContent).toContain('暂无可用角色模板');
  });
});
