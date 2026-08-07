import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { initialState, isResolvedContextBindingStale } from '../hub-cat-editor.model';

const cat: CatData = {
  id: 'codex',
  displayName: 'Codex',
  clientId: 'openai',
  accountRef: 'codex-oauth',
  provider: 'openai',
  defaultModel: 'gpt-5.4',
  color: { primary: '#000', secondary: '#fff' },
  mentionPatterns: ['@codex'],
  avatar: '🐱',
  roleDescription: 'review',
  personality: 'careful',
  cli: { carrier: 'exec_json' },
  resolvedContext: {
    windowTokens: 200_000,
    source: 'manual',
    bindingKey: {
      member: 'codex',
      client: 'openai',
      account: 'codex-oauth',
      provider: 'openai',
      model: 'gpt-5.4',
      carrier: 'exec_json',
    },
    observedAt: 123,
  },
};

describe('#1208 resolved context binding invalidation', () => {
  it('invalidates account, provider, model, client, and carrier changes', () => {
    const form = initialState(cat);
    expect(isResolvedContextBindingStale(cat, form)).toBe(false);
    expect(isResolvedContextBindingStale(cat, { ...form, accountRef: 'sponsor-2' })).toBe(true);
    expect(isResolvedContextBindingStale(cat, { ...form, provider: 'openrouter' })).toBe(true);
    expect(isResolvedContextBindingStale(cat, { ...form, defaultModel: 'gpt-5.5' })).toBe(true);
    expect(isResolvedContextBindingStale(cat, { ...form, clientId: 'opencode' })).toBe(true);
    expect(isResolvedContextBindingStale(cat, { ...form, codexCarrier: 'app_server' })).toBe(true);
  });
});
