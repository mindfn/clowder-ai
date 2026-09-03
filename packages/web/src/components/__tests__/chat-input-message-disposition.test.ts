import type { ActiveExecutionProjection, MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/components/AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        mentionPatterns: ['@布偶猫', '@opus'],
        roleDescription: 'reviewer',
        avatar: '/opus.png',
        roster: { available: true },
      },
      {
        id: 'codex',
        displayName: '缅因猫',
        mentionPatterns: ['@缅因猫', '@codex'],
        roleDescription: 'reviewer',
        avatar: '/codex.png',
        roster: { available: true },
      },
    ],
    isLoading: false,
  }),
}));

const mockApiFetch = vi.fn((path: string, init?: RequestInit) => globalThis.fetch(path, init));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: (...args: [string, RequestInit?]) => mockApiFetch(...args),
}));

const productSnapshot: MessageDispositionPreferenceSnapshot = {
  productDefault: 'next_work',
  global: null,
  thread: null,
  effective: 'next_work',
  source: 'product',
  onboardingSeen: false,
};

function dispositionSnapshot(
  overrides: Partial<MessageDispositionPreferenceSnapshot> = {},
): MessageDispositionPreferenceSnapshot {
  return { ...productSnapshot, ...overrides };
}

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function seedCanonicalExecutions(threadId: string, catIds: string[] = ['opus'], appendableCatIds: string[] = []): void {
  const appendable = new Set(appendableCatIds);
  const executions = catIds.map<ActiveExecutionProjection>((catId, index) => {
    const executionId = `inv-${catId}-${index}`;
    return {
      executionId,
      threadId,
      threadTitle: 'Test thread',
      catId,
      kind: 'live_invocation',
      startedAt: Date.now() + index,
      cancelability: {
        state: 'cancelable',
        target: { kind: 'live_invocation', threadId, catId, executionId },
      },
      ...(appendable.has(catId)
        ? {
            inputCapabilities: {
              append: {
                kind: 'append' as const,
                expectedRun: {
                  targetId: catId,
                  invocationId: `turn-${catId}`,
                  responseMessageId: `response-${catId}`,
                },
              },
            },
          }
        : {}),
    };
  });
  useActiveExecutionStore.setState({
    anchorThreadId: threadId,
    projectPath: '/project/cafe',
    executionsByKey: Object.fromEntries(executions.map((execution) => [activeExecutionKey(execution), execution])),
    hydration: 'ready',
    hydrationError: null,
  });
}

describe('F264 author message disposition selector', () => {
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
    mockApiFetch.mockClear();
    useChatStore.setState({
      targetCats: ['opus'],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'openai_codex',
            carrier: 'codex_app_server',
            deliverySemantics: 'exact_active_turn',
          },
        },
      },
    });
    useActiveExecutionStore.getState().reset();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const snapshot =
        body?.scope === 'thread'
          ? { ...productSnapshot, thread: body.disposition, effective: body.disposition, source: 'thread' }
          : body?.scope === 'onboarding'
            ? { ...productSnapshot, onboardingSeen: true }
            : productSnapshot;
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function chooseContinueCurrent() {
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => {
      (container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement).click();
    });
    return trigger;
  }

  async function typeAndSend(value: string) {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => setTextarea(textarea, value));
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function renderThreadInput(props: React.ComponentProps<typeof ChatInput>) {
    await act(async () => {
      useChatStore.setState({
        currentThreadId: props.threadId,
        hasActiveInvocation: props.hasActiveInvocation ?? false,
      });
      root.render(React.createElement(ChatInput, props));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('appears only for live work and consumes a one-shot override after successful admission', async () => {
    const onSend = vi.fn(async () => true);
    await renderThreadInput({ threadId: 'thread-1', onSend, hasActiveInvocation: false });
    expect(container.querySelector('[data-testid="message-disposition-trigger"]')).toBeNull();

    await renderThreadInput({ threadId: 'thread-1', onSend, hasActiveInvocation: true });
    const trigger = await chooseContinueCurrent();
    expect(trigger.textContent).toContain('接着当前工作');
    await typeAndSend('顺手看一下问题 B');

    expect(onSend).toHaveBeenCalledWith(
      '顺手看一下问题 B',
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );
    expect(trigger.textContent).toContain('下一件工作');
  });

  it('retains a one-shot override when admission fails', async () => {
    const onSend = vi.fn(async () => false);
    await renderThreadInput({ threadId: 'thread-2', onSend, hasActiveInvocation: true });
    const trigger = await chooseContinueCurrent();
    await typeAndSend('网络失败也别吃掉我的选择');

    expect(onSend).toHaveBeenCalledWith(
      '网络失败也别吃掉我的选择',
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );
    expect(trigger.textContent).toContain('接着当前工作');
  });

  it('confirms that draft Steer stops the target reply before sending', async () => {
    const onSend = vi.fn(async () => true);
    seedCanonicalExecutions('thread-3');
    await renderThreadInput({ threadId: 'thread-3', onSend, hasActiveInvocation: true });
    const trigger = await chooseContinueCurrent();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => setTextarea(textarea, '现在就换轨'));
    await act(async () => {
      (container.querySelector('[aria-label="Steer 发送选项"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Steer');
    expect(container.textContent).toContain('@布偶猫');
    expect(container.textContent).not.toContain('这不是“追加到当前回复”');

    await act(async () => {
      (container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith('现在就换轨', undefined, undefined, 'steer', undefined, undefined, undefined, [
      'opus',
    ]);
    expect(trigger.textContent).toContain('接着当前工作');
  });

  it('lets an unaddressed draft choose one current member before stopping and sending', async () => {
    const onSend = vi.fn(async () => true);
    seedCanonicalExecutions('thread-steer-target', ['opus', 'codex']);
    useChatStore.setState({
      targetCats: ['opus', 'codex'],
      activeInvocations: {
        'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
        'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
    });
    await renderThreadInput({ threadId: 'thread-steer-target', onSend, hasActiveInvocation: true });
    act(() => setTextarea(container.querySelector('textarea') as HTMLTextAreaElement, '请现在处理这个'));
    act(() => (container.querySelector('[aria-label="Steer 发送选项"]') as HTMLButtonElement).click());

    expect(container.querySelector('[data-testid="steer-target-opus"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="steer-target-codex"]')).not.toBeNull();
    act(() => (container.querySelector('[data-testid="steer-target-codex"]') as HTMLButtonElement).click());
    await act(async () => {
      (container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      '请现在处理这个',
      undefined,
      undefined,
      'steer',
      undefined,
      undefined,
      undefined,
      ['codex'],
    );
  });

  it('locks an explicitly addressed draft to that current member', async () => {
    const onSend = vi.fn(async () => true);
    seedCanonicalExecutions('thread-steer-addressed', ['opus', 'codex']);
    useChatStore.setState({
      targetCats: ['opus', 'codex'],
      activeInvocations: {
        'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
        'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
    });
    await renderThreadInput({ threadId: 'thread-steer-addressed', onSend, hasActiveInvocation: true });
    act(() => setTextarea(container.querySelector('textarea') as HTMLTextAreaElement, '@缅因猫 请现在改一下'));
    act(() => (container.querySelector('[aria-label="Steer 发送选项"]') as HTMLButtonElement).click());

    expect(container.querySelector('[data-testid="steer-target-codex"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="steer-target-opus"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      '@缅因猫 请现在改一下',
      undefined,
      undefined,
      'steer',
      undefined,
      undefined,
      undefined,
      ['codex'],
    );
  });

  it('offers non-interrupting send as an intent even when the selected member has no active Append carrier', async () => {
    const onSend = vi.fn(async () => true);
    seedCanonicalExecutions('thread-steer-append', ['opus', 'codex'], ['opus']);
    useChatStore.setState({
      targetCats: ['opus', 'codex'],
      activeInvocations: {
        'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
        'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {},
    });
    await renderThreadInput({ threadId: 'thread-steer-append', onSend, hasActiveInvocation: true });
    act(() => setTextarea(container.querySelector('textarea') as HTMLTextAreaElement, '补充一个约束'));
    act(() => (container.querySelector('[aria-label="Steer 发送选项"]') as HTMLButtonElement).click());

    expect(container.querySelector('[data-testid="steer-append"]')).not.toBeNull();
    act(() => (container.querySelector('[data-testid="steer-target-codex"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="steer-append"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="steer-append"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      '补充一个约束',
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
      undefined,
      ['codex'],
    );
  });

  it('can persist the choice for this thread instead of changing every send', async () => {
    await renderThreadInput({ threadId: 'thread-4', onSend: vi.fn(), hasActiveInvocation: true });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => (container.querySelector('[data-disposition-scope="thread"]') as HTMLButtonElement).click());
    await act(async () => {
      (container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const put = mockApiFetch.mock.calls.find((call) => {
      if (call[0] !== '/api/config/message-disposition' || call[1]?.method !== 'PUT') return false;
      return JSON.parse(String(call[1].body)).scope === 'thread';
    });
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      scope: 'thread',
      threadId: 'thread-4',
      disposition: 'continue_current',
    });
    expect(trigger.textContent).toContain('接着当前工作');

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => (container.querySelector('[data-disposition-scope="thread"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="message-disposition-scope-state"]')?.textContent).toContain(
      '本作用域已显式覆盖',
    );
    expect(container.querySelector('[data-disposition-option="continue_current"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows contextual onboarding only on the first meaningful open', async () => {
    await renderThreadInput({ threadId: 'thread-5', onSend: vi.fn(), hasActiveInvocation: true });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;

    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="message-disposition-onboarding"]')).not.toBeNull();

    act(() => trigger.click());
    act(() => trigger.click());
    expect(container.querySelector('[data-testid="message-disposition-onboarding"]')).toBeNull();
  });

  it('keeps continue-current selectable when the server may need to start next work', async () => {
    const onSend = vi.fn(async () => true);
    useChatStore.setState({
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'anthropic',
            carrier: 'claude_print_sdk',
            deliverySemantics: 'unsupported',
          },
        },
      },
    });
    await renderThreadInput({ threadId: 'thread-6', onSend, hasActiveInvocation: true });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('下一件工作');
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const continueOption = container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement;
    const nextWorkOption = container.querySelector('[data-disposition-option="next_work"]') as HTMLButtonElement;
    expect(continueOption.disabled).toBe(false);
    expect(continueOption.className).not.toContain('disabled:cursor-not-allowed');
    expect(continueOption.className).not.toContain('disabled:cursor-wait');
    expect(nextWorkOption.disabled).toBe(false);
    expect(container.textContent).toContain('当前接入不支持本轮读取');
    expect(container.textContent).toContain('服务端会把它作为下一件工作启动');

    act(() => continueOption.click());
    expect(trigger.textContent).toContain('接着当前工作');
    await typeAndSend('接入不支持也保留我的意图');
    expect(onSend).toHaveBeenCalledWith(
      '接入不支持也保留我的意图',
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );

    act(() => {
      useChatStore.setState({
        catInvocations: { opus: { invocationId: 'inv-active' } },
      });
    });
    await renderThreadInput({ threadId: 'thread-6', onSend, hasActiveInvocation: true });
    await act(async () => {
      (container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('能力未声明');
  });

  it('shows inherited effective values as inherited instead of scope-local overrides', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse(
        dispositionSnapshot({
          global: 'continue_current',
          effective: 'continue_current',
          source: 'global',
          onboardingSeen: true,
        }),
      ),
    );

    await renderThreadInput({ threadId: 'thread-inherited', onSend: vi.fn(), hasActiveInvocation: true });

    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    const scopeState = container.querySelector('[data-testid="message-disposition-scope-state"]');
    expect(scopeState?.textContent).toContain('继承当前有效值');
    expect(scopeState?.textContent).toContain('全局默认');
    expect(container.querySelector('[data-disposition-option="continue_current"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(container.querySelector('[data-disposition-option="next_work"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('resets one-shot and Thread A state before Thread B preference hydration completes', async () => {
    let resolveThreadB: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const path = String(input);
      if (path.includes('threadId=thread-a')) {
        return Promise.resolve(
          jsonResponse(
            dispositionSnapshot({
              thread: 'continue_current',
              effective: 'continue_current',
              source: 'thread',
              onboardingSeen: true,
            }),
          ),
        );
      }
      if (path.includes('threadId=thread-b')) {
        return new Promise<Response>((resolve) => {
          resolveThreadB = resolve;
        });
      }
      return Promise.resolve(jsonResponse(productSnapshot));
    });

    await renderThreadInput({ threadId: 'thread-a', onSend: vi.fn(), hasActiveInvocation: true });

    const triggerA = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      triggerA.click();
      await Promise.resolve();
    });
    act(() => (container.querySelector('[data-disposition-option="next_work"]') as HTMLButtonElement).click());
    expect(triggerA.textContent).toContain('仅这一次');

    await renderThreadInput({ threadId: 'thread-b', onSend: vi.fn(), hasActiveInvocation: true });

    const triggerB = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    expect(triggerB.textContent).toContain('接着当前工作');
    expect(triggerB.textContent).toContain('产品默认');
    expect(triggerB.textContent).not.toContain('仅这一次');
    expect(triggerB.textContent).not.toContain('本 Thread');

    await act(async () => {
      resolveThreadB?.(
        jsonResponse(
          dispositionSnapshot({
            global: 'continue_current',
            effective: 'continue_current',
            source: 'global',
            onboardingSeen: true,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(triggerB.textContent).toContain('全局默认');
    expect(triggerB.textContent).not.toContain('本 Thread');
  });
});
