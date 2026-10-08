import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useChatStore } from '@/stores/chatStore';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({
  ImagePreview: () => null,
}));
vi.mock('@/components/AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('@/utils/compressImage', () => ({
  compressImage: (f: File) => Promise.resolve(f),
}));

// Mock api-client: expose apiFetch as a spy that delegates to globalThis.fetch
// This lets tests verify apiFetch is called (not raw fetch), catching regressions
// where someone switches back to fetch('/api/game/start', ...).
const mockApiFetch = vi.fn((path: string, init?: RequestInit) => globalThis.fetch(path, init));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: (...args: [string, RequestInit?]) => mockApiFetch(...args),
}));

// Mock useCatData to return enough cats for a 7-player game (6 cat seats in player mode)
const mockCats = ['opus', 'sonnet', 'codex', 'gpt52', 'spark', 'gemini'].map((id) => ({
  id,
  displayName: id,
  color: { primary: '#888', secondary: '#666' },
  avatar: `/avatars/${id}.png`,
  mentionPatterns: [id],
  provider: 'test',
  defaultModel: 'test',
  roleDescription: '',
  personality: '',
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: mockCats, isLoading: false }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockApiFetch.mockClear();
  useChatStore.setState({ currentThreadId: 'game-test', messages: [], threadStates: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function openGameMenu() {
  const addBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
  expect(addBtn).toBeTruthy();
  act(() => {
    addBtn.click();
  });

  const gameBtn = document.querySelector('[data-testid="composer-game"]') as HTMLButtonElement;
  expect(gameBtn).toBeTruthy();
  act(() => {
    gameBtn.click();
  });
}

function openReadyLobby() {
  openGameMenu();
  for (const id of ['game-item-werewolf', 'game-mode-player']) {
    const item = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    expect(item).toBeTruthy();
    act(() => item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  }
  for (const cat of mockCats) {
    const toggle = container.querySelector(`[data-testid="cat-toggle-${cat.id}"]`) as HTMLButtonElement;
    act(() => toggle.click());
  }
  const confirm = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  return confirm;
}

function gamePosts() {
  return mockApiFetch.mock.calls.filter(([path]) => path === '/api/game/start');
}

function successfulStart() {
  return new Response(JSON.stringify({ status: 'game_started', gameId: 'g1', gameThreadId: 'gt1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('game start upload guard', () => {
  it('blocks the actual POST from a ready lobby during upload, then permits it when upload ends', async () => {
    const onSend = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => successfulStart());
    const render = (uploadStatus: 'idle' | 'uploading') =>
      act(() => root.render(React.createElement(ChatInput, { onSend, uploadStatus })));
    render('idle');
    const confirm = openReadyLobby();
    render('uploading');
    // All game prerequisites are valid; only the upload state prevents the request.
    await act(async () => confirm.click());
    expect(gamePosts()).toHaveLength(0);
    expect(onSend).not.toHaveBeenCalled();
    render('idle');
    await act(async () => confirm.click());
    expect(gamePosts()).toHaveLength(1);
    expect(gamePosts()[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(gamePosts()[0][1]?.body)).catIds).toEqual(mockCats.map((cat) => cat.id));
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('progressive add menu coordinates with the game menu', () => {
  it('opening the add menu dismisses the game menu', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false }));
    });

    openGameMenu();
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeTruthy();

    const addBtn = container.querySelector('button[aria-label="添加"]') as HTMLButtonElement;
    act(() => {
      addBtn.click();
    });
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeNull();
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeTruthy();
  });
});

describe('layer drill-in does not trigger outside-click close', () => {
  it('clicking werewolf drills into modes (layer 2 visible)', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false }));
    });

    // Open game menu
    openGameMenu();
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeTruthy();

    // Click werewolf to drill in
    const werewolfItem = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      werewolfItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Layer 2 should be visible (mode selection)
    expect(container.querySelector('[data-testid="game-mode-player"]')).toBeTruthy();
    // Layer 1 should be gone
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeNull();
  });
});

describe('game start failure handling', () => {
  it.each(['HTTP', 'network'] as const)('%s error is reported and the selected lobby can retry', async (failure) => {
    const onSend = vi.fn();
    const errorText = failure === 'HTTP' ? 'Thread already has an active game' : 'Network error';
    let failNextGameStart = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      // Draft hydration may read first; inject at the game mutation, not the first fetch.
      if (String(input).includes('/api/game/start') && init?.method === 'POST' && failNextGameStart) {
        failNextGameStart = false;
        if (failure === 'HTTP') return new Response(JSON.stringify({ error: errorText }), { status: 409 });
        throw new Error(errorText);
      }
      return successfulStart();
    });
    act(() => root.render(React.createElement(ChatInput, { onSend, threadId: 'game-test' })));
    const confirm = openReadyLobby();
    await act(async () => confirm.click());

    expect(gamePosts()).toHaveLength(1);
    expect(gamePosts()[0][1]?.method).toBe('POST');
    const firstPayload = JSON.parse(String(gamePosts()[0][1]?.body));
    expect(firstPayload.catIds).toEqual(mockCats.map((cat) => cat.id));
    expect(useChatStore.getState().getThreadState('game-test').messages).toEqual([
      expect.objectContaining({ type: 'system', variant: 'error', content: `开局失败: ${errorText}` }),
    ]);
    const retry = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    expect(retry.disabled).toBe(false);
    // Reconfirm without reselecting: proves both selection retention and the in-flight lock's release.
    await act(async () => retry.click());
    expect(gamePosts()).toHaveLength(2);
    expect(JSON.parse(String(gamePosts()[1][1]?.body))).toEqual(firstPayload);
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('game start calls dedicated API', () => {
  it('can start while a chat invocation is active, without sending a chat message', async () => {
    const onSend = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => successfulStart());
    act(() => root.render(React.createElement(ChatInput, { onSend, hasActiveInvocation: true })));
    const confirm = openReadyLobby();
    await act(async () => confirm.click());
    expect(gamePosts()).toHaveLength(1);
    expect(gamePosts()[0][1]?.method).toBe('POST');
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});
