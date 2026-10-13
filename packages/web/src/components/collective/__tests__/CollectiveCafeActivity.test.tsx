import type { CollectiveClientContext } from '@cat-cafe/shared';
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveCafeHost } from '../CollectiveCafeHost';
import type { ParticipationView } from '../use-collective-participation';

let view: ParticipationView | undefined;
const mutate = vi.fn();
vi.mock('../use-collective-participation', () => ({
  useCollectiveParticipation: () => ({ view, busy: false, mutate, reload: vi.fn() }),
  useCollectiveAutoReconcile: vi.fn(),
}));
vi.mock('../use-collective-work-policy', () => ({ useCollectiveWorkPolicy: () => ({}) }));

const context: CollectiveClientContext = {
  type: 'collective:client-context',
  bridgeId: 'bridge_12345678',
  contextId: 'context_12345678',
  revision: 1,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  humanId: 'human_12345678',
  channelId: 'general',
  channelIds: ['general'],
  openCafe: false,
};

const baseProps = {
  connection: { connectionId: 'con_12345678', authorityStatus: 'connected' },
  context,
  onClose: vi.fn(),
  onPair: vi.fn(),
  onMutate: vi.fn(),
  connections: [],
  onSelectConnection: vi.fn(),
} as unknown as ComponentProps<typeof CollectiveCafeHost>;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mutate.mockReset();
  view = {
    revision: 1,
    published: true,
    reconcileRequired: false,
    cats: [{ id: 'codex-astra', displayName: '小星星', configured: true, eligible: true, supported: true }],
    desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
    observedEligibility: {},
    channelRoutes: {
      general: {
        channelId: 'general',
        threadId: 'thread_general',
        participants: { 'codex-astra': { displayName: '小星星' } },
      },
    },
    standingInterests: {},
    attentionRevision: 0,
    bindings: {},
    threads: [],
    requests: [],
    tasks: [],
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('removes the duplicate sidebar activity block and opens the private roster only on request', async () => {
  await act(async () => root.render(<CollectiveCafeHost {...baseProps} />));
  expect(container.querySelector('[aria-label="家里近况"]')).toBeNull();
  expect(container.textContent).not.toContain('猫猫动态');
  expect(container.querySelector('[aria-label="我的猫"]')).toBeNull();

  await act(async () => root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true }} />));
  expect(container.querySelector('[aria-label="我的猫"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="我的猫"]')).not.toBeNull();
  expect(container.textContent).not.toContain('家里的对话仍然只属于你');
});

it('opens channel listening directly when the channel menu requests that private section', async () => {
  await act(async () =>
    root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true, cafeSection: 'channel' }} />),
  );

  expect(container.querySelector('section[aria-label="# general 的消息回应"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="我的猫"]')).toBeNull();
});

it.each([
  ['cats', '正在读取我的猫…'],
  ['channel', '正在读取频道设置…'],
  ['permissions', '正在读取已允许的工作…'],
] as const)('keeps the %s section truthful while its first snapshot is loading', async (cafeSection, copy) => {
  view = undefined;
  await act(async () =>
    root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true, cafeSection }} />),
  );

  expect(container.textContent).toContain(copy);
});
