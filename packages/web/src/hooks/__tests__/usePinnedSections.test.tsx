import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePinnedSections } from '@/hooks/usePinnedSections';

const STORAGE_KEY = 'cat-cafe:pinned-settings-sections';
const DESKTOP_SEED_KEY = 'cat-cafe:pinned-settings-sections:desktop-seeded';

type PinnedSectionsState = ReturnType<typeof usePinnedSections>;

describe('usePinnedSections', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: PinnedSectionsState | null;

  function Probe() {
    latest = usePinnedSections();
    return null;
  }

  beforeEach(() => {
    localStorage.clear();
    delete window.desktopBridge;
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    localStorage.clear();
    delete window.desktopBridge;
  });

  function renderHook() {
    React.act(() => {
      root.render(<Probe />);
    });
    if (!latest) throw new Error('usePinnedSections probe did not render');
    return latest;
  }

  it('ignores non-array localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: true }));

    const state = renderHook();

    expect(state.pinned).toEqual([]);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(false);
  });

  it('ignores string localStorage payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('accounts'));

    const state = renderHook();

    expect(state.pinned).toEqual([]);
    expect(() => state.isPinned('accounts')).not.toThrow();
    expect(state.isPinned('accounts')).toBe(false);
  });

  it('filters non-string entries from array payloads', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['accounts', null, 42, 'skills']));

    const state = renderHook();

    expect(state.pinned).toEqual(['accounts', 'skills']);
    expect(state.isPinned('accounts')).toBe(true);
    expect(state.isPinned('skills')).toBe(true);
  });

  it('does not seed desktop defaults in an ordinary browser', () => {
    const state = renderHook();

    expect(state.pinned).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(DESKTOP_SEED_KEY)).toBeNull();
  });

  it('seeds members and accounts once on the first packaged-desktop mount', () => {
    Object.defineProperty(window, 'desktopBridge', { value: {}, configurable: true, writable: true });

    const state = renderHook();

    expect(state.pinned).toEqual(['members', 'accounts']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['members', 'accounts']);
    expect(localStorage.getItem(DESKTOP_SEED_KEY)).toBe('1');
  });

  it('preserves existing pins while adding desktop defaults on the first packaged launch', () => {
    Object.defineProperty(window, 'desktopBridge', { value: {}, configurable: true, writable: true });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['skills', 'members']));

    const state = renderHook();

    expect(state.pinned).toEqual(['skills', 'members', 'accounts']);
  });

  it('remembers a user unpin after the desktop defaults have been seeded', () => {
    Object.defineProperty(window, 'desktopBridge', { value: {}, configurable: true, writable: true });
    let state = renderHook();

    React.act(() => state.unpin('members'));
    expect(latest?.pinned).toEqual(['accounts']);

    React.act(() => root.render(null));
    state = renderHook();

    expect(state.pinned).toEqual(['accounts']);
    expect(localStorage.getItem(DESKTOP_SEED_KEY)).toBe('1');
  });
});
