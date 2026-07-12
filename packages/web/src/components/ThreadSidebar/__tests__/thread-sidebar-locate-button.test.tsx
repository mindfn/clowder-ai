import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const NOW = 1710000000000;

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: 'default',
    title: null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

async function clickTab(container: HTMLElement, tabId: string, flush: () => Promise<void>) {
  const tab = container.querySelector(`[data-testid="sidebar-tab-${tabId}"]`) as HTMLButtonElement;
  await act(async () => {
    tab.click();
  });
  await flush();
}

describe('ThreadSidebar locate button (Select Open Session)', () => {
  let harness: ThreadSidebarHarness;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });
    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({ id: 'recent', title: 'Recent Thread', projectPath: '/proj/b', lastActiveAt: NOW - 1_000 }),
        makeThread({ id: 'project', title: 'Project Thread', projectPath: '/proj/a', lastActiveAt: NOW - 2_000 }),
        makeThread({
          id: 'favorite',
          title: 'Favorite Thread',
          favorited: true,
          projectPath: '/proj/a',
          lastActiveAt: NOW - 3_000,
        }),
        makeThread({ id: 'system', title: 'System Thread', systemKind: 'eval_domain', lastActiveAt: NOW - 4_000 }),
      ],
      currentThreadId: 'recent',
      threadStates: {},
      isLoadingThreads: false,
    });
    const labels = [{ id: 'lbl-a', name: '开源', color: '#5B8C5A', sortOrder: 0, createdBy: 'u1', createdAt: 1 }];
    useLabelStore.setState({ labels, isLoading: false });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk(labels);
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it('flat toolbar shows thread count and locate button', async () => {
    await harness.render();

    const toolbar = harness.container.querySelector('[data-testid="flat-toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.textContent).toContain('个对话');

    const locateBtn = toolbar?.querySelector('[data-testid="select-open-session-btn"]');
    expect(locateBtn).not.toBeNull();
  });

  it('clicking locate button scrolls to the active thread', async () => {
    await harness.render();
    scrollIntoView.mockClear();

    const locateBtn = harness.container.querySelector('[data-testid="select-open-session-btn"]') as HTMLButtonElement;
    expect(locateBtn).not.toBeNull();

    await act(async () => {
      locateBtn.click();
    });
    await harness.flush();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('project toolbar shows locate button alongside expand/collapse', async () => {
    await harness.render();
    await clickTab(harness.container, 'project', harness.flush);

    const toolbar = harness.container.querySelector('[data-testid="project-toolbar"]');
    expect(toolbar).not.toBeNull();

    const locateBtn = toolbar?.querySelector('[data-testid="project-select-open-session-btn"]');
    const expandBtn = toolbar?.querySelector('[data-testid="expand-all-btn"]');
    const collapseBtn = toolbar?.querySelector('[data-testid="collapse-all-btn"]');
    expect(locateBtn).not.toBeNull();
    expect(expandBtn).not.toBeNull();
    expect(collapseBtn).not.toBeNull();
  });

  it('expands collapsed project group and scrolls to active thread on locate click', async () => {
    await harness.render();
    await clickTab(harness.container, 'project', harness.flush);

    // Active thread ('recent' in /proj/b) should be visible initially
    expect(harness.container.querySelector('[data-thread-id="recent"]')).not.toBeNull();

    // Collapse all project groups
    const collapseBtn = harness.container.querySelector('[data-testid="collapse-all-btn"]') as HTMLButtonElement;
    await act(async () => {
      collapseBtn.click();
    });
    await harness.flush();

    // Active thread should be hidden (collapsed)
    expect(harness.container.querySelector('[data-thread-id="recent"]')).toBeNull();
    scrollIntoView.mockClear();

    // Queue rAF callbacks: scrollToActiveThread uses 2 nested requestAnimationFrame.
    // jsdom's native rAF doesn't reliably flush via setTimeout, so we intercept and drain manually.
    const rafQueue: FrameRequestCallback[] = [];
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;

    try {
      // Click the project locate button — toggleGroup expands the group, rAF1 is queued
      const locateBtn = harness.container.querySelector(
        '[data-testid="project-select-open-session-btn"]',
      ) as HTMLButtonElement;
      await act(async () => {
        locateBtn.click();
      });
      await harness.flush(); // React re-renders: group expanded, thread element appears in DOM

      // Drain rAF queue (each callback may schedule more)
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        if (!cb) break;
        await act(async () => {
          cb(0);
        });
        await harness.flush();
      }

      // Group should be expanded and thread visible again
      expect(harness.container.querySelector('[data-thread-id="recent"]')).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    } finally {
      window.requestAnimationFrame = origRAF;
    }
  });
});
