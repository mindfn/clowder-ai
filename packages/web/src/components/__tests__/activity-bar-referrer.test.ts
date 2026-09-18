import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getThreadIdFromPathname, pinnedSections } = vi.hoisted(() => ({
  getThreadIdFromPathname: vi.fn((pathname: string) => {
    const match = pathname.match(/^\/thread\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : 'default';
  }),
  pinnedSections: [] as string[],
}));

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/thread/thread-abc',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname,
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: ({ className }: { className?: string }) => React.createElement('span', { className }, 'M'),
}));

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: pinnedSections, pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('@/components/hub-icons', () => ({
  HubIcon: ({ name, className }: { name: string; className?: string }) =>
    React.createElement('span', { className }, name),
}));

vi.mock('@/components/settings/settings-nav-config', () => ({
  SETTINGS_SECTIONS: [
    { id: 'members', label: '成员与运行时', icon: 'users' },
    { id: 'accounts', label: '账户与密钥', icon: 'key' },
  ],
}));

import { ActivityBar } from '@/components/ActivityBar';

describe('ActivityBar referrer forwarding (P2 fix)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockPush.mockClear();
    pinnedSections.splice(0);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('keeps only conversation, theme, and settings in the default rail', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const titles = Array.from(container.querySelectorAll('button[title]')).map((button) =>
      button.getAttribute('title'),
    );
    expect(titles).toEqual(['对话', '主题', '设置']);
  });

  it('does NOT append ?from= when clicking the home button', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const homeBtn = container.querySelector('button[title="对话"]') as HTMLElement;
    expect(homeBtn).toBeTruthy();

    React.act(() => {
      homeBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('places user-pinned settings immediately after conversation without a separator', () => {
    pinnedSections.push('members', 'accounts');
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const titles = Array.from(container.querySelectorAll('button[title]')).map((button) =>
      button.getAttribute('title'),
    );
    expect(titles).toEqual(['对话', '成员与运行时', '账户与密钥', '主题', '设置']);
    expect(container.querySelector('.h-px')).toBeNull();
  });

  it('encodes existing ?from= when routing back to a thread from the home button', () => {
    const originalSearch = window.location.search;
    const threadId = 'thread/with space?x#frag';
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: `?from=${encodeURIComponent(threadId)}` },
      writable: true,
      configurable: true,
    });

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const homeBtn = container.querySelector('button[title="对话"]') as HTMLElement;
    expect(homeBtn).toBeTruthy();

    React.act(() => {
      homeBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith(`/thread/${encodeURIComponent(threadId)}`);

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    });
  });
});
