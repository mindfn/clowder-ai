import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { AppendedInputReceipts } from '../AppendedInputReceipts';

vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'lang' }) }));

vi.mock('@/utils/focusLineageMessage', () => ({ focusLineageMessage: vi.fn() }));

Object.assign(globalThis as Record<string, unknown>, { React });

const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
}

const STARTED_AT = new Date('2026-09-01T14:14:00.000Z').getTime();
const LONG_TEXT = '@opus 你先暂停一下 你先给我讲讲你们目前的进度到了哪里了？ 之前都让你们干什么然后你们都做成啥样了？';

function source(id: string, content: string, offsetSeconds: number): ChatMessage {
  return {
    id,
    from: { kind: 'user', userId: 'co-creator' },
    type: 'user',
    content,
    timestamp: STARTED_AT + offsetSeconds * 1_000,
  };
}

function responseFor(sources: readonly ChatMessage[]): ChatMessage {
  const initial = source('source-initial', '@opus 开始', 0);
  return {
    id: 'response-1',
    from: { kind: 'agent', catId: 'opus' },
    type: 'assistant',
    catId: 'opus',
    content: '收到',
    timestamp: STARTED_AT,
    lifecycle: {
      kind: 'response',
      orderKey: '1:response-1',
      invocationId: 'invocation-1',
      targetId: 'opus',
      inputEntryIds: ['entry-initial', ...sources.map((item) => `entry-${item.id}`)],
      inputMessageIds: [initial.id, ...sources.map((item) => item.id)],
      status: 'processing',
      startedAt: STARTED_AT,
    },
  };
}

async function measure(element: Element, size: { clientWidth: number; scrollWidth: number }) {
  for (const [key, value] of Object.entries(size)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([{ target: element } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

function requireElement<T extends Element>(element: T | null): T {
  if (!element) throw new Error('Expected element to exist');
  return element;
}

function buttonNamed(row: Element, name: string): HTMLButtonElement | undefined {
  return Array.from(row.querySelectorAll('button')).find((button) => button.textContent === name);
}

describe('AppendedInputReceipts: expand in place, jump separately', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
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
    resizeCallbacks.clear();
    vi.mocked(focusLineageMessage).mockReset();
  });

  async function render(sources: readonly ChatMessage[]) {
    await act(async () => {
      root.render(
        <AppendedInputReceipts
          response={responseFor(sources)}
          timelineMessages={sources}
          getCatById={() => undefined}
        />,
      );
    });
  }

  function row(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-appended-input-id="${id}"]`);
    if (!element) throw new Error(`row ${id} not rendered`);
    return element;
  }

  it('keeps unsupported delivery static without claiming a model read', async () => {
    await render([source('unsupported', '补充一条消息', 5)]);
    const status = row('unsupported').querySelector<HTMLButtonElement>('[data-append-delivery-state]');
    expect(status?.dataset.appendDeliveryState).toBe('unavailable');
    expect(status?.getAttribute('aria-label')).toBe('已投递；读取状态不可用');
    expect(status?.querySelector('.animate-pulse')).toBeNull();
    await act(async () => status?.click());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('已投递；读取状态不可用');
  });

  it('joins only the exact target and stops animation when its response terminates', async () => {
    const input = source('tracked', '稍后给出结论', 8);
    input.lifecycle = {
      kind: 'input',
      orderKey: 'input:tracked',
      dispatchRefs: [
        {
          targetId: 'opus',
          statusMessageId: 'response-1',
          phase: 'dispatched',
          dispatchedAt: input.timestamp,
          inputRead: { status: 'pending' },
        },
        {
          targetId: 'other-cat',
          statusMessageId: 'other-response',
          phase: 'dispatched',
          dispatchedAt: input.timestamp,
          inputRead: { status: 'read', at: input.timestamp + 1 },
        },
      ],
    };
    await render([input]);
    expect(
      row('tracked').querySelector('[data-append-delivery-state]')?.getAttribute('data-append-delivery-state'),
    ).toBe('pending');
    expect(row('tracked').querySelector('.animate-pulse')).not.toBeNull();
    const lifecycle = responseFor([input]).lifecycle;
    if (lifecycle?.kind !== 'response') throw new Error('Expected response');
    const terminal: ChatMessage = {
      ...responseFor([input]),
      lifecycle: { ...lifecycle, status: 'canceled', completedAt: input.timestamp + 2 },
    };
    await act(async () =>
      root.render(
        <AppendedInputReceipts response={terminal} timelineMessages={[input]} getCatById={() => undefined} />,
      ),
    );
    expect(row('tracked').querySelector('.animate-pulse')).toBeNull();
    expect(row('tracked').querySelector('[data-append-delivery-state]')?.getAttribute('aria-label')).toBe(
      '已投递；读取未确认',
    );
    input.lifecycle = {
      ...input.lifecycle,
      dispatchRefs: input.lifecycle.dispatchRefs?.map((ref) =>
        ref.targetId === 'opus' ? { ...ref, inputRead: { status: 'read', at: input.timestamp + 3 } } : ref,
      ),
    };
    await act(async () =>
      root.render(
        <AppendedInputReceipts response={terminal} timelineMessages={[input]} getCatById={() => undefined} />,
      ),
    );
    expect(row('tracked').querySelector('[data-append-delivery-state]')?.getAttribute('aria-label')).toBe('已读取');
  });

  it('offers 展开全文 only when the line is truncated, and expands the full text in place', async () => {
    await render([source('short', '好的', 5), source('long', LONG_TEXT, 8)]);

    await measure(requireElement(row('short').querySelector('[data-overflow-measure="inline"]')), {
      clientWidth: 240,
      scrollWidth: 240,
    });
    await measure(requireElement(row('long').querySelector('[data-overflow-measure="inline"]')), {
      clientWidth: 240,
      scrollWidth: 720,
    });

    expect(buttonNamed(row('short'), '展开全文')).toBeUndefined();
    const expand = buttonNamed(row('long'), '展开全文');
    expect(expand?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => expand?.click());

    expect(row('long').dataset.expanded).toBe('true');
    expect(row('long').textContent).toContain(LONG_TEXT);
    const collapse = buttonNamed(row('long'), '收起');
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    expect(focusLineageMessage).not.toHaveBeenCalled();

    await act(async () => collapse?.click());
    expect(row('long').dataset.expanded).toBe('false');
    expect(buttonNamed(row('long'), '展开全文')).toBeDefined();
  });

  it('jumps back to the original message with its own 跳到原文 action', async () => {
    await render([source('appended', LONG_TEXT, 8)]);

    expect(container.textContent).not.toContain('查看原文');
    await act(async () => buttonNamed(row('appended'), '跳到原文')?.click());

    expect(focusLineageMessage).toHaveBeenCalledWith('appended');
    expect(row('appended').dataset.expanded).toBe('false');
  });

  it('lifts the 3.5-row clamp while a row is expanded, and 收起 folds the list and its rows', async () => {
    const sources = [1, 2, 3, 4, 5].map((index) => source(`s${index}`, `${LONG_TEXT} #${index}`, index));
    await render(sources);
    const list = requireElement(container.querySelector<HTMLElement>('[data-testid="appended-input-list"]'));
    expect(list.dataset.collapsed).toBe('true');

    const newest = row('s5');
    await measure(requireElement(newest.querySelector('[data-overflow-measure="inline"]')), {
      clientWidth: 240,
      scrollWidth: 720,
    });
    await act(async () => buttonNamed(newest, '展开全文')?.click());

    expect(list.dataset.collapsed).toBe('false');
    const listToggle = container.querySelector<HTMLButtonElement>('button[aria-label="收起补充消息"]');
    expect(listToggle).not.toBeNull();

    await act(async () => listToggle?.click());

    expect(list.dataset.collapsed).toBe('true');
    expect(row('s5').dataset.expanded).toBe('false');
  });
});
