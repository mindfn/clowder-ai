import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { HubMemberOverviewCard } from '../HubMemberOverviewCard';

const cat: CatData = {
  id: 'test-codex',
  displayName: 'Test Codex',
  clientId: 'openai',
  defaultModel: 'test',
  color: { primary: '#5B8C5A', secondary: '#FFFFFF' },
  mentionPatterns: ['@test-codex'],
  avatar: '',
  roleDescription: '',
  personality: '',
  adapterMode: 'cli',
  codexCarrier: { effective: 'app_server', source: 'per-cat' },
};

describe('Hub member actions and effective transport', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('toggle and delete call their own action without opening the row editor', () => {
    const onEdit = vi.fn();
    const onToggleAvailability = vi.fn();
    const onDelete = vi.fn();
    act(() => root.render(<HubMemberOverviewCard {...{ cat, onEdit, onToggleAvailability, onDelete }} />));
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="停用成员：Test Codex"]');
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="删除成员"]');
    expect(toggle).not.toBeNull();
    expect(remove).not.toBeNull();
    act(() => {
      toggle?.click();
      remove?.click();
    });
    expect(onToggleAvailability).toHaveBeenCalledExactlyOnceWith(cat);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(cat);
    expect(onEdit).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLElement>('[data-testid="cat-card-test-codex"]')?.click());
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(cat);
  });

  it('shows the effective app-server carrier, with ACP taking precedence', () => {
    act(() => root.render(<HubMemberOverviewCard cat={cat} />));
    expect(host.textContent).toContain('APP SERVER');
    act(() => root.render(<HubMemberOverviewCard cat={{ ...cat, adapterMode: 'acp' }} />));
    expect(host.textContent).toContain('ACP');
    expect(host.textContent).not.toContain('APP SERVER');
  });
});
