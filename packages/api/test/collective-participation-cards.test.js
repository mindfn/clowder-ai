import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registeredCollectiveCats } from '../dist/domains/plugin/builtin-runtime/collective-participation-cards.js';

test('registered Collective cards distinguish same-breed Cats and keep their own profile', () => {
  const cards = registeredCollectiveCats(
    [
      {
        id: 'codex',
        displayName: '缅因猫',
        nickname: '砚砚',
        variantLabel: 'GPT-5.3 Codex',
        breedDisplayName: '缅因猫',
        avatar: '/avatars/codex.png',
        roleDescription: '代码审查',
        defaultModel: 'gpt-5.3-codex',
      },
      {
        id: 'codex-sol',
        displayName: '缅因猫',
        nickname: '砚砚',
        variantLabel: 'GPT-6 Sol',
        breedDisplayName: '缅因猫',
        avatar: '/avatars/codex-sol.png',
        roleDescription: '复杂实现',
        defaultModel: 'gpt-6-sol',
      },
    ],
    () => true,
  );
  assert.deepEqual(cards, [
    {
      id: 'codex',
      displayName: '缅因猫（GPT-5.3 Codex）',
      nickname: '砚砚',
      variantLabel: 'GPT-5.3 Codex',
      breedDisplayName: '缅因猫',
      supported: true,
      avatar: '/avatars/codex.png',
      roleDescription: '代码审查',
      defaultModel: 'gpt-5.3-codex',
    },
    {
      id: 'codex-sol',
      displayName: '缅因猫（GPT-6 Sol）',
      nickname: '砚砚',
      variantLabel: 'GPT-6 Sol',
      breedDisplayName: '缅因猫',
      supported: true,
      avatar: '/avatars/codex-sol.png',
      roleDescription: '复杂实现',
      defaultModel: 'gpt-6-sol',
    },
  ]);
});
