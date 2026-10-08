import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/stores/label-store', () => ({ useLabelStore: () => ({ labels: [] }) }));
vi.mock('../ThreadSettingsPanel', () => ({ ThreadSettingsPanel: () => null }));
vi.mock('@/components/ExportButton', () => ({ ExportButton: () => null }));

import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThreadItem } from '../ThreadItem';

let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const pin = vi.fn();
function render(pinned: boolean, canPin = true, id = 'thread') {
  act(() =>
    root.render(
      <ThreadItem
        id={id}
        title="Target"
        participants={[]}
        lastActiveAt={0}
        isActive={false}
        onSelect={select}
        onTogglePin={canPin ? pin : undefined}
        isPinned={pinned}
        presence={{ status: 'idle' }}
        unreadCount={0}
        hasUserMention={false}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  writeShellPresentation('v2');
  writeShellLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellPresentation('classic');
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
it('exposes the pin truth at one fixed slot and toggles without selecting the conversation', () => {
  render(false);
  const button = host.querySelector<HTMLButtonElement>('[data-testid="thread-pin-button"]');
  expect(button).not.toBeNull();
  expect(button?.getAttribute('aria-label')).toBe('Pin Target');
  expect(button?.getAttribute('aria-pressed')).toBe('false');
  expect(button?.className).toContain('group-hover:opacity-100');
  expect(button?.className).toContain('group-focus-within:opacity-100');
  expect(button?.className).toContain('[@media(hover:none)]:opacity-100');
  expect(button?.className).toContain('w-4');
  expect(button?.querySelector('svg')?.getAttribute('fill')).toBe('none');
  act(() => button?.click());
  expect(pin).toHaveBeenLastCalledWith('thread', true);
  expect(select).not.toHaveBeenCalled();
  render(true);
  const pinned = host.querySelector<HTMLButtonElement>('[data-testid="thread-pin-button"]');
  expect(pinned?.getAttribute('aria-pressed')).toBe('true');
  expect(pinned?.getAttribute('aria-label')).toBe('Unpin Target');
  expect(pinned?.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
  expect(pinned?.getAttribute('style')).toContain('--shell-primary');
  expect(pinned?.className).not.toContain('opacity-0');
  act(() => pinned?.click());
  expect(pin).toHaveBeenLastCalledWith('thread', false);
  expect(select).not.toHaveBeenCalled();
});
it('keeps a read-only pinned mark visible and never creates a default-thread pin action', () => {
  render(true, false);
  expect(host.querySelector('[data-testid="thread-pin-mark"]')?.getAttribute('aria-label')).toBe('Pinned');
  render(false, true, 'default');
  expect(host.querySelector('[data-testid="thread-pin-button"]')).toBeNull();
});
it('keeps the classic Chinese stroke pin unchanged in either shell language', () => {
  writeShellPresentation('classic');
  render(true);
  const button = host.querySelector('[data-testid="thread-pin-button"]');
  expect(button?.getAttribute('aria-label')).toBe('取消置顶 Target');
  expect(button?.getAttribute('title')).toBe('取消置顶');
  expect(button?.querySelector('svg')?.getAttribute('fill')).toBe('none');
});
