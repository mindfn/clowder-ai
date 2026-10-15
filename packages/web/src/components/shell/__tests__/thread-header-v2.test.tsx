import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ mode: vi.fn(), tasks: [] as { status: string }[] }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { setWorkspaceMode: typeof data.mode }) => unknown) => s({ setWorkspaceMode: data.mode }),
}));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (s: (v: { tasks: typeof data.tasks }) => unknown) => s({ tasks: data.tasks }),
}));

import { ThreadTasksButton, ThreadWorksButton } from '../HeaderCounts';

describe('F322 thread-scoped header facts', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() =>
      root.render(
        <>
          <ThreadWorksButton />
          <ThreadTasksButton />
        </>,
      ),
    );
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    data.tasks = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' || matches.call(this, selector);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('counts only unfinished tasks; works does not invent a number; actions retain original modes', () => {
    data.tasks = ['todo', 'doing', 'blocked', 'done', 'done'].map((status) => ({ status }));
    render();
    const tasks = host.querySelector<HTMLButtonElement>('[data-testid="header-tasks"]');
    const works = host.querySelector<HTMLButtonElement>('[data-testid="header-works"]');
    if (!tasks || !works) throw new Error('Thread header actions are missing');
    expect(tasks.textContent).toBe('任务3');
    expect(tasks.getAttribute('aria-label')).toBe('任务 3，这条对话的任务');
    expect(works.textContent).toBe('作品');
    expect(works.getAttribute('aria-label')).not.toMatch(/\d/);
    act(() => {
      tasks.click();
      works.click();
    });
    expect(data.mode.mock.calls).toEqual([['tasks'], ['artifacts']]);
    expect(host.querySelector('[title]')).toBeNull();
  });
  it('all-done or unread initial tasks do not claim a numeric zero', () => {
    data.tasks = [{ status: 'done' }];
    render();
    expect(host.querySelector('[data-testid="header-tasks"]')?.textContent).toBe('任务');
  });
});
