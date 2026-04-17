// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '../../utils/api-client';
import { BootcampGuideOverlay } from '../first-run-quest/BootcampGuideOverlay';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

const mockApiFetch = vi.mocked(apiFetch);

function flushEffects() {
  return act(async () => {
    await Promise.resolve();
  });
}

function createDeferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function OverlayHarness({ threadId }: { threadId: string }) {
  const thread = useChatStore((state) => state.threads.find((item) => item.id === threadId));
  const bootcampState = thread?.bootcampState;
  if (!bootcampState) return null;
  const guideStep = bootcampState.guideStep as 'open-hub' | 'click-add-member' | 'fill-form' | 'done' | undefined;
  return (
    <BootcampGuideOverlay
      phase={bootcampState.phase}
      guideStep={guideStep}
      threadId={threadId}
      bootcampState={{ ...bootcampState, guideStep }}
    />
  );
}

describe('BootcampGuideOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let rafId: number;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    useChatStore.setState({ threads: [] });

    rafCallbacks = new Map();
    rafId = 0;
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++rafId;
      rafCallbacks.set(id, callback);
      return id;
    });
    window.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders PreviewResultGuide when phase-4 guideStep is preview-result', async () => {
    await act(async () => {
      root.render(
        <BootcampGuideOverlay
          phase="phase-7-dev"
          catName="布偶猫"
          hasMessages
          guideStep="preview-result"
          threadId="thread-123"
          bootcampState={{ v: 1, phase: 'phase-7-dev', guideStep: 'preview-result', startedAt: Date.now() }}
        />,
      );
    });

    expect(container.textContent).toContain('看看布偶猫做的效果');
  });

  it('keeps the intro full-screen overlay and input tip for phase-1 before any messages', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-1-intro" catName="布偶猫" hasMessages={false} />);
    });

    expect(container.textContent).toContain('在下方输入框输入 @布偶猫 你好  开始训练营');
    expect(container.querySelector('.fixed.inset-0')).not.toBeNull();
  });

  it('renders lifecycle tip for phase-7-dev without guideStep when there are messages', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-7-dev" catName="布偶猫" hasMessages />);
    });

    expect(container.textContent).toContain('猫猫正在开发');
  });

  it('advances the add-teammate guide even when the target element appears after the overlay mounts', async () => {
    await act(async () => {
      root.render(
        <BootcampGuideOverlay
          phase="phase-7.5-add-teammate"
          guideStep="open-hub"
          threadId="thread-123"
          bootcampState={{
            phase: 'phase-7.5-add-teammate',
            guideStep: 'open-hub',
            v: 1,
            startedAt: 123,
          }}
        />,
      );
    });
    await flushEffects();

    const lateButton = document.createElement('button');
    lateButton.setAttribute('data-bootcamp-step', 'hub-button');
    lateButton.textContent = '打开 Hub';
    document.body.appendChild(lateButton);

    await act(async () => {
      lateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-123',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"guideStep":"click-add-member"'),
      }),
    );

    lateButton.remove();
  });

  it('auto-advances from open-hub when the hub is already open on mount', async () => {
    const addMemberButton = document.createElement('button');
    addMemberButton.setAttribute('data-bootcamp-step', 'add-member-button');
    addMemberButton.textContent = '+ 添加成员';
    document.body.appendChild(addMemberButton);

    await act(async () => {
      root.render(
        <BootcampGuideOverlay
          phase="phase-7.5-add-teammate"
          guideStep="open-hub"
          threadId="thread-456"
          bootcampState={{
            phase: 'phase-7.5-add-teammate',
            guideStep: 'open-hub',
            v: 1,
            startedAt: 456,
          }}
        />,
      );
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-456',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"guideStep":"click-add-member"'),
      }),
    );

    addMemberButton.remove();
  });

  it('updates the visible tip after the patch succeeds', async () => {
    useChatStore.setState({
      threads: [
        {
          id: 'thread-store-sync',
          projectPath: 'default',
          title: null,
          createdBy: 'user',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
          bootcampState: {
            v: 1,
            phase: 'phase-7.5-add-teammate',
            guideStep: 'open-hub',
            startedAt: 1,
          },
        },
      ],
    });

    const hubButton = document.createElement('button');
    hubButton.setAttribute('data-bootcamp-step', 'hub-button');
    hubButton.textContent = '打开 Hub';
    document.body.appendChild(hubButton);

    await act(async () => {
      root.render(<OverlayHarness threadId="thread-store-sync" />);
    });
    await flushEffects();

    expect(container.textContent).toContain('觉得有改进空间');

    const addMemberButton = document.createElement('button');
    addMemberButton.setAttribute('data-bootcamp-step', 'add-member-button');
    addMemberButton.textContent = '+ 添加成员';
    document.body.appendChild(addMemberButton);

    await act(async () => {
      hubButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('点击「+ 添加成员」按钮');

    hubButton.remove();
    addMemberButton.remove();
  });

  it('optimistically switches to the next tip before the patch resolves', async () => {
    const deferred = createDeferredResponse();
    mockApiFetch.mockImplementationOnce(() => deferred.promise);

    useChatStore.setState({
      threads: [
        {
          id: 'thread-optimistic',
          projectPath: 'default',
          title: null,
          createdBy: 'user',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
          bootcampState: {
            v: 1,
            phase: 'phase-7.5-add-teammate',
            guideStep: 'open-hub',
            startedAt: 1,
          },
        },
      ],
    });

    const hubButton = document.createElement('button');
    hubButton.setAttribute('data-bootcamp-step', 'hub-button');
    hubButton.textContent = '打开 Hub';
    document.body.appendChild(hubButton);

    await act(async () => {
      root.render(<OverlayHarness threadId="thread-optimistic" />);
    });
    await flushEffects();

    expect(container.textContent).toContain('觉得有改进空间');

    const addMemberButton = document.createElement('button');
    addMemberButton.setAttribute('data-bootcamp-step', 'add-member-button');
    addMemberButton.textContent = '+ 添加成员';
    document.body.appendChild(addMemberButton);

    await act(async () => {
      hubButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('点击「+ 添加成员」按钮');

    await act(async () => {
      deferred.resolve(new Response('{}', { status: 200 }));
      await Promise.resolve();
    });

    hubButton.remove();
    addMemberButton.remove();
  });

  it('does not block the next guide transition while the previous patch is still pending', async () => {
    const firstDeferred = createDeferredResponse();
    const secondDeferred = createDeferredResponse();
    mockApiFetch
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    useChatStore.setState({
      threads: [
        {
          id: 'thread-multi-step',
          projectPath: 'default',
          title: null,
          createdBy: 'user',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
          bootcampState: {
            v: 1,
            phase: 'phase-7.5-add-teammate',
            guideStep: 'open-hub',
            startedAt: 1,
          },
        },
      ],
    });

    const hubButton = document.createElement('button');
    hubButton.setAttribute('data-bootcamp-step', 'hub-button');
    hubButton.textContent = '打开 Hub';
    document.body.appendChild(hubButton);

    await act(async () => {
      root.render(<OverlayHarness threadId="thread-multi-step" />);
    });
    await flushEffects();

    const addMemberButton = document.createElement('button');
    addMemberButton.setAttribute('data-bootcamp-step', 'add-member-button');
    addMemberButton.textContent = '+ 添加成员';
    document.body.appendChild(addMemberButton);

    await act(async () => {
      hubButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('点击「+ 添加成员」按钮');

    const catEditor = document.createElement('div');
    catEditor.setAttribute('data-bootcamp-step', 'cat-editor');
    catEditor.textContent = '编辑器';
    document.body.appendChild(catEditor);

    await act(async () => {
      addMemberButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('填写猫猫信息');
    expect(mockApiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/threads/thread-multi-step',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"guideStep":"fill-form"'),
      }),
    );

    await act(async () => {
      firstDeferred.resolve(new Response('{}', { status: 200 }));
      secondDeferred.resolve(new Response('{}', { status: 200 }));
      await Promise.resolve();
    });

    hubButton.remove();
    addMemberButton.remove();
    catEditor.remove();
  });

  it('falls back to open-hub when click-add-member is persisted but the hub is closed', async () => {
    vi.useFakeTimers();

    useChatStore.setState({
      threads: [
        {
          id: 'thread-recover-open-hub',
          projectPath: 'default',
          title: null,
          createdBy: 'user',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
          bootcampState: {
            v: 1,
            phase: 'phase-7.5-add-teammate',
            guideStep: 'click-add-member',
            startedAt: 1,
          },
        },
      ],
    });

    const hubButton = document.createElement('button');
    hubButton.setAttribute('data-bootcamp-step', 'hub-button');
    hubButton.textContent = '打开 Hub';
    document.body.appendChild(hubButton);

    await act(async () => {
      root.render(<OverlayHarness threadId="thread-recover-open-hub" />);
    });
    await flushEffects();

    expect(container.textContent).toContain('点击「+ 添加成员」按钮');

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('觉得有改进空间');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-recover-open-hub',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"guideStep":"open-hub"'),
      }),
    );

    hubButton.remove();
  });
});
