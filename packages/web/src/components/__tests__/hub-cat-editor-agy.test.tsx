import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { buildCatPatchPayload, initialState } from '../hub-cat-editor.model';
import { AccountSection } from '../hub-cat-editor.sections';

const cat: CatData = {
  id: 'gemini38',
  displayName: '烁烁',
  clientId: 'google',
  accountRef: 'gemini',
  defaultModel: 'Gemini 3.8 Flash (High)',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@gemini38'],
  avatar: '/avatars/default.png',
  roleDescription: 'test',
  personality: '',
};
const profile = {
  enabled: true,
  carrier: 'native' as const,
  profileId: 'gemini38',
  homeRoot: '/isolated/profiles',
  model: 'gemini-3.8-flash-high',
  autoApprove: false,
  trustedWorkspaces: ['/approved/workspace'],
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('AGY Native member settings', () => {
  it('offers Native for Gemini and binds profile fields to the transport choice', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <AccountSection
          form={initialState(cat)}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    const transport = container.querySelector<HTMLSelectElement>('select[aria-label="Transport"]');
    expect(Array.from(transport?.options ?? []).map((option) => option.value)).toContain('agy-native');
    await act(async () => {
      if (!transport) throw new Error('Transport missing');
      transport.value = 'agy-native';
      transport.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ agyNativeEnabled: true, acpEnabled: false }));
    await act(async () =>
      root.render(
        <AccountSection
          form={{ ...initialState(cat), agyNativeEnabled: true }}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    expect(container.textContent).toContain('隔离 Profile');
    expect(container.textContent).toContain('批准工作区');
    await act(async () =>
      root.render(
        <AccountSection
          form={initialState({ ...cat, clientId: 'kimi' })}
          modelOptions={[]}
          availableProfiles={[]}
          loadingProfiles={false}
          onChange={onChange}
        />,
      ),
    );
    expect(container.querySelector('option[value="agy-native"]')).toBeNull();
  });

  it('round trips Native configuration and uses the physical model ID', () => {
    const nativeCat = { ...cat, agyProfile: profile };
    const form = initialState(nativeCat);
    expect(form.agyNativeEnabled).toBe(true);
    expect(form.defaultModel).toBe(profile.model);
    expect(form.agyTrustedWorkspaces).toBe('/approved/workspace');
    const payload = buildCatPatchPayload(form, nativeCat, { accountAuthType: 'oauth' });
    expect(payload.agyProfile).toEqual(profile);
    expect(payload.defaultModel).toBe(profile.model);
  });

  it('clears Native on CLI / ACP / client changes, without leaking a coding grant', () => {
    const nativeCat = { ...cat, agyProfile: profile };
    for (const patch of [{ agyNativeEnabled: false }, { acpEnabled: true }, { clientId: 'openai' as const }]) {
      const payload = buildCatPatchPayload({ ...initialState(nativeCat), ...patch }, nativeCat);
      expect(payload.agyProfile).toBeNull();
    }
    const legacy = {
      ...initialState(cat),
      agyNativeEnabled: true,
      agyProfileId: 'gemini38',
      defaultModel: profile.model,
      agyHomeRoot: '',
      agyTrustedWorkspaces: '/approved/workspace',
      cliConfigArgs: ['--unsafe-option'],
    };
    const payload = buildCatPatchPayload(
      legacy,
      { ...cat, cliConfigArgs: ['--unsafe-option'] },
      { accountAuthType: 'oauth' },
    );
    expect(payload.cliConfigArgs).toEqual([]);
    expect(payload.agyProfile).not.toHaveProperty('nativeCodingGrant');
    expect(() => buildCatPatchPayload({ ...legacy, agyTrustedWorkspaces: '' }, cat)).toThrow(/工作区/);
    expect(() => buildCatPatchPayload({ ...legacy, agyTrustedWorkspaces: 'relative/path' }, cat)).toThrow(/绝对路径/);
    expect(() => buildCatPatchPayload({ ...legacy, defaultModel: cat.defaultModel }, cat)).toThrow(/模型/);
    expect(() => buildCatPatchPayload(legacy, cat, { accountAuthType: 'api_key' })).toThrow(/OAuth/);
  });
});
