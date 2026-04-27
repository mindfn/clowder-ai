import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAccountItem } from '@/components/HubAccountItem';
import type { ProfileItem } from '@/components/hub-accounts.types';

describe('HubAccountItem', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('clicking the card triggers onEdit', async () => {
    const profile: ProfileItem = {
      id: 'claude-api',
      provider: 'claude-api',
      displayName: 'Claude API',
      name: 'Claude API',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };
    const onEdit = vi.fn();

    await act(async () => {
      root.render(
        <HubAccountItem
          profile={profile}
          busy={false}
          onSave={vi.fn(async () => {})}
          onDelete={() => {}}
          onEdit={onEdit}
        />,
      );
    });

    expect(container.textContent).toContain('Claude API');
    expect(container.textContent).toContain('已配置');
    expect(container.textContent).toContain('预览 / 编辑 →');

    const card = container.querySelector('button') as HTMLElement;
    await act(async () => {
      card.click();
    });
    expect(onEdit).toHaveBeenCalledWith(profile);
  });

  it('shows summary with host and API key status for non-builtin accounts', async () => {
    const profile: ProfileItem = {
      id: 'codex-sponsor',
      provider: 'codex-sponsor',
      displayName: 'Codex Sponsor',
      name: 'Codex Sponsor',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://proxy.example',
      models: ['gpt-5.4'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).toContain('proxy.example');
    expect(container.textContent).toContain('已配置');
  });

  it('shows 内置 badge and 预览 → for builtin profiles', async () => {
    const profile: ProfileItem = {
      id: 'codex-oauth',
      provider: 'codex-oauth',
      displayName: 'Codex (OAuth)',
      name: 'Codex (OAuth)',
      authType: 'oauth',
      kind: 'builtin',
      builtin: true,
      mode: 'subscription',
      models: ['gpt-5.4'],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('Codex (OAuth)');
    expect(container.textContent).toContain('内置');
    expect(container.textContent).toContain('预览 →');
    expect(container.textContent).not.toContain('预览 / 编辑 →');
  });

  it('shows 未配置 status when no API key and not builtin', async () => {
    const profile: ProfileItem = {
      id: 'opencode-client-auth',
      provider: 'opencode-client-auth',
      displayName: 'OpenCode (client-auth)',
      name: 'OpenCode (client-auth)',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      models: [],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('OpenCode (client-auth)');
    expect(container.textContent).toContain('未配置');
  });
});
