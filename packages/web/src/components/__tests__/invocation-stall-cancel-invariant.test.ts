/**
 * Red tests: Cancel invariant for invocation stall scenarios.
 *
 * Bug: "猫猫正在回复中" displayed for 30+ minutes with no cancel button.
 *
 * Invariant to lock:
 * - alive_but_silent MUST remain exactly cancelable beside its projected execution
 * - diagnostic status banners MUST NOT duplicate that execution-scoped control
 * - whole-thread Stop has one composer action; status banners remain diagnostic
 */

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({ apiFetch: mockApiFetch }));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex' ? { displayName: '缅因猫 (Codex)', id: 'codex' } : null),
  }),
}));

const storeState: Record<string, unknown> = {
  targetCats: ['codex'],
  activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 300_000 } },
  catStatuses: {},
  catInvocations: {},
  currentThreadId: 'thread-1',
};

function liveExecution(): ActiveExecutionProjection {
  return {
    executionId: 'inv-1',
    threadId: 'thread-1',
    threadTitle: 'Test thread',
    catId: 'codex',
    kind: 'live_invocation',
    startedAt: Date.now() - 300_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: 'thread-1', catId: 'codex', executionId: 'inv-1' },
    },
  };
}

function seedExecutionProjection(): void {
  const execution = liveExecution();
  useActiveExecutionStore.setState({
    anchorThreadId: 'thread-1',
    projectPath: '/project/cafe',
    executionsByKey: { [activeExecutionKey(execution)]: execution },
    hydration: 'ready',
    hydrationError: null,
  });
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));

describe('Invocation stall cancel invariant', () => {
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
    mockApiFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(url.endsWith('/executions/active') ? { projectPath: '/project/cafe', executions: [] } : {}),
      }),
    );
    storeState.targetCats = ['codex'];
    storeState.activeInvocations = { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 300_000 } };
    storeState.catStatuses = {};
    storeState.catInvocations = {};
    storeState.currentThreadId = 'thread-1';
    useActiveExecutionStore.getState().reset();
    seedExecutionProjection();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 1: alive_but_silent remains cancelable without a duplicate banner control
  // ─────────────────────────────────────────────────────────────────────────
  it('alive_but_silent keeps one exact execution cancel beside the projected member', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150_000,
          cpuTimeMs: 4200,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const [{ ThinkingIndicator }, { ThreadExecutionBar }] = await Promise.all([
      import('../ThinkingIndicator'),
      import('../ThreadExecutionBar'),
    ]);
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ThinkingIndicator),
          React.createElement(ThreadExecutionBar),
        ),
      );
    });

    const cancelButtons = container.querySelectorAll('[aria-label="Stop codex live_invocation inv-1"]');
    expect(cancelButtons).toHaveLength(1);
    expect(cancelButtons[0]?.textContent).toBe('×');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 2: alive_but_silent cancel uses the exact execution-scoped endpoint
  // ─────────────────────────────────────────────────────────────────────────
  it('alive_but_silent cancel button targets the projected execution identity', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150_000,
          cpuTimeMs: 4200,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const [{ ThinkingIndicator }, { ThreadExecutionBar }] = await Promise.all([
      import('../ThinkingIndicator'),
      import('../ThreadExecutionBar'),
    ]);
    act(() => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ThinkingIndicator),
          React.createElement(ThreadExecutionBar),
        ),
      );
    });

    const cancelBtn = container.querySelector('[aria-label="Stop codex live_invocation inv-1"]') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();

    await act(async () => {
      cancelBtn.click();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-1/executions/live/inv-1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'codex' }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ChatInput "猫猫正在回复中" banner is diagnostic. The composer action button
// owns the sole whole-thread Stop; execution-scoped cancellation lives beside
// the projected execution itself (F295).
// ─────────────────────────────────────────────────────────────────────────
describe('ChatInput active invocation banner cancel invariant (structural)', () => {
  it('banner block does not duplicate the composer whole-thread Stop', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(import.meta.dirname, '..', 'ChatInput.tsx'), 'utf-8');

    // Find the hasActiveInvocation banner block
    const bannerIdx = source.indexOf('hasActiveInvocation && (');
    expect(bannerIdx).toBeGreaterThan(-1);

    // Extract the banner block through the following disposition surface.
    const afterBanner = source.slice(bannerIdx);
    const closingIdx = afterBanner.indexOf('{dispositionIsMeaningful && (');
    expect(closingIdx).toBeGreaterThan(-1);
    const bannerBlock = afterBanner.slice(0, closingIdx);

    // INVARIANT: banner MUST have a testid for identification
    expect(bannerBlock).toContain('data-testid="active-invocation-banner"');

    expect(bannerBlock).not.toContain('banner-cancel-btn');
    expect(bannerBlock).not.toContain('chat_input_banner');
  });
});
