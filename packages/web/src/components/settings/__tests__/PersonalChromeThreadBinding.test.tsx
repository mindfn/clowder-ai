import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { PersonalChromeThreadBinding } from '../PersonalChromeThreadBinding';

const mockApiFetch = vi.mocked(apiFetch);
const conversations = [
  {
    conversationId: 'conversation-owner-a',
    authorizedAt: '2026-08-23T07:00:00.000Z',
    updatedAt: '2026-08-23T07:00:00.000Z',
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(label));
}

describe('PersonalChromeThreadBinding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    useChatStore.setState({
      currentThreadId: 'thread-owner-journey',
      threads: [
        {
          id: 'thread-owner-journey',
          projectPath: 'default',
          title: 'F247 owner journey',
          createdBy: 'default-user',
          participants: [],
          lastActiveAt: 0,
          createdAt: 0,
        } as never,
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('completes the current-thread route after Host authorization without exposing an API path', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-owner-journey/cloud-bindings' && !init?.method) {
        return jsonResponse({ bindings: {}, cloudCat: { status: 'resolved', catId: 'gpt-pro' } });
      }
      if (url === '/api/threads/thread-owner-journey/cloud-bindings' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          catId: 'gpt-pro',
          chatUrl: 'https://chatgpt.com/c/conversation-owner-a',
        });
        return jsonResponse({
          bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-owner-a' },
        });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromeThreadBinding conversations={conversations} disabled={false} />));
    await flushEffects();

    expect(container.textContent).toContain('当前 thread 路由');
    expect(container.textContent).toContain('F247 owner journey');
    expect(container.textContent).toContain('还差一步');
    expect(container.textContent).not.toContain('/api/threads');

    await act(async () => findButton(container, '用于当前 thread')?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-owner-journey/cloud-bindings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        catId: 'gpt-pro',
        chatUrl: 'https://chatgpt.com/c/conversation-owner-a',
      }),
    });
    expect(container.textContent).toContain('当前 thread 已路由到');
    expect(container.textContent).toContain('conversation-owner-a');
  });

  it('reports a route whose Host authorization was revoked and offers an exact replacement', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-revoked' },
        cloudCat: { status: 'resolved', catId: 'gpt-pro' },
      }),
    );

    await act(async () => root.render(<PersonalChromeThreadBinding conversations={conversations} disabled={false} />));
    await flushEffects();

    expect(container.textContent).toContain('conversation-revoked');
    expect(container.textContent).toContain('已不在 Host 授权集合中');
    expect(findButton(container, '用于当前 thread')).toBeDefined();
  });

  // F202 h3c-2 — the settings route binds the cat the Host resolves as the cloud cat, whatever its id.
  it('routes the thread for the configured cloud cat, whatever its id', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-owner-journey/cloud-bindings' && !init?.method) {
        return jsonResponse({
          bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-stale' },
          cloudCat: { status: 'resolved', catId: 'cloud-alt' },
        });
      }
      if (url === '/api/threads/thread-owner-journey/cloud-bindings' && init?.method === 'PATCH') {
        const { catId, chatUrl } = JSON.parse(String(init.body));
        return jsonResponse({ bindings: { [catId]: chatUrl } });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromeThreadBinding conversations={conversations} disabled={false} />));
    await flushEffects();
    expect(container.textContent).not.toContain('conversation-stale');

    await act(async () => findButton(container, '用于当前 thread')?.click());
    await flushEffects();

    const patch = mockApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      catId: 'cloud-alt',
      chatUrl: 'https://chatgpt.com/c/conversation-owner-a',
    });
    expect(container.textContent).toContain('当前 thread 已路由到');
  });

  it.each([
    [{ status: 'unavailable' }, '还没有配置云端猫'],
    [{ status: 'ambiguous', catIds: ['cloud-alt', 'cloud-beta'] }, 'cloud-alt、cloud-beta'],
  ])('offers no route while the Host has no single cloud cat (%o)', async (cloudCat, message) => {
    mockApiFetch.mockResolvedValue(jsonResponse({ bindings: {}, cloudCat }));

    await act(async () => root.render(<PersonalChromeThreadBinding conversations={conversations} disabled={false} />));
    await flushEffects();

    expect(container.textContent).toContain(message);
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
