import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS_ENTRY_ID, findEntry } from '@/components/settings/settings-ia';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { WorkspaceToolsContent } from '../WorkspaceToolsContent';

vi.mock('next/navigation', () => ({
  usePathname: () => null,
  useRouter: () => {
    throw new Error('invariant: no Next router in the original external Workbench host');
  },
}));

describe('Workspace tools in the original external host', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellLanguage('zh');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const render = async (onOpenSettings = vi.fn(), onClose = vi.fn()) => {
    const callbacks = {
      onSelectDestination: vi.fn(),
      onSelectDevSurface: vi.fn(),
      recentSurfaces: [],
      onSelectRecentSurface: vi.fn(),
      onOpenSettings,
      onClose,
    };
    await act(async () => root.render(<WorkspaceToolsContent {...callbacks} />));
  };
  it('mounts the actual tool menu without requiring a Next router', async () => {
    await render();
    expect(host.querySelector('[data-testid="workspace-tools-content"]')).not.toBeNull();
  });
  it('hands the original Settings entry to the host before closing the menu', async () => {
    const order: string[] = [];
    const onOpenSettings = vi.fn(() => order.push('settings'));
    await render(
      onOpenSettings,
      vi.fn(() => order.push('close')),
    );
    const settings = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '设置与管理',
    );
    expect(settings).toBeDefined();
    await act(async () => settings?.click());
    expect(onOpenSettings).toHaveBeenCalledWith(findEntry(DEFAULT_SETTINGS_ENTRY_ID));
    expect(order).toEqual(['settings', 'close']);
  });
});
