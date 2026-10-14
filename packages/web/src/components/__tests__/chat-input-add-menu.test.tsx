import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInputAddMenu } from '@/components/ChatInputAddMenu';

describe('ChatInputAddMenu', () => {
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    trigger = document.createElement('button');
    trigger.getBoundingClientRect = () =>
      ({ top: 640, left: 16, right: 48, bottom: 672, width: 32, height: 32, x: 16, y: 640, toJSON() {} }) as DOMRect;
    document.body.appendChild(container);
    document.body.appendChild(trigger);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    trigger.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(props: Partial<React.ComponentProps<typeof ChatInputAddMenu>> = {}) {
    const defaults = {
      onAttach: vi.fn(),
      onAddContext: vi.fn(),
      onWhisperToggle: vi.fn(),
      onGameClick: vi.fn(),
      onClose: vi.fn(),
      triggerRef: { current: trigger },
      ...props,
    };
    act(() => root.render(<ChatInputAddMenu {...defaults} />));
    return defaults;
  }

  function menu() {
    return document.querySelector<HTMLElement>('[data-testid="composer-add-menu"]');
  }

  it('groups context, upload and optional modes behind one menu', () => {
    render();
    expect(menu()?.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    expect(menu()?.textContent).toContain('引用 Thread 或文件');
    expect(menu()?.textContent).toContain('上传附件');
    expect(menu()?.textContent).toContain('图片、文档或压缩包，最多 5 个');
    expect(menu()?.textContent).toContain('悄悄话');
    expect(menu()?.textContent).toContain('游戏');
  });

  it('closes before routing a selected action', () => {
    const callbacks = render();
    act(() => menu()?.querySelector<HTMLButtonElement>('[data-testid="composer-add-context"]')?.click());
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddContext).toHaveBeenCalledTimes(1);
  });

  it('shows whisper as stateful only after the mode is active', () => {
    render({ whisperMode: true });
    const whisper = menu()?.querySelector<HTMLButtonElement>('[data-testid="composer-whisper"]');
    expect(whisper?.className).toContain('bg-accent-50');
    expect(whisper?.textContent).toContain('已开启');
  });

  it('disables upload at the image limit without blocking context', () => {
    render({ maxImages: true });
    expect(menu()?.querySelector<HTMLButtonElement>('[data-testid="composer-upload"]')?.disabled).toBe(true);
    expect(menu()?.querySelector<HTMLButtonElement>('[data-testid="composer-add-context"]')?.disabled).toBe(false);
  });

  it('closes from Escape without requiring focus inside the menu', () => {
    const callbacks = render();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it('portals the grown menu into a viewport-bounded scrolling surface', () => {
    render();
    const menu = document.querySelector<HTMLElement>('[data-testid="composer-add-menu"]');
    const surface = menu?.closest<HTMLElement>('[role="dialog"]');
    expect(surface?.style.position).toBe('fixed');
    expect(surface?.style.maxHeight).toBe('626px');
    expect(surface?.className).toContain('overflow-y-auto');
  });
});
