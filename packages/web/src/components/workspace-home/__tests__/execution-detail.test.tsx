import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySearchModal } from '@/components/HistorySearchModal';
import { SteerQueuedEntryModal } from '@/components/SteerQueuedEntryModal';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { clearExecutionDetailRequest, requestExecutionDetail } from '../execution-detail-request';
import { HomeLiveCard } from '../HomeLiveCard';
import { command, NOW, seed } from './home-fixtures';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), cancel: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: mocks.cancel }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({ displayName: '缅因猫', nickname: '小太阳·砚砚', variantLabel: 'GPT-6.1 Sol' }),
  }),
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span /> }));

const run = command('codex61-sol', 'thread-command-source', 'hold-exact', 'full_gate', NOW - 10_000);
const valid = {
  taskId: run.executionId,
  catId: run.catId,
  access: { lifecycleVisibility: 'full' },
  lifecycle: {
    mode: 'wake_when',
    managedCommand: { command: 'pnpm gate --label exact-source', state: 'command_running', startedAt: run.startedAt },
  },
};
describe('managed execution details in Workspace Now', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellLanguage('zh');
    clearExecutionDetailRequest();
    useChatStore.setState({ currentThreadId: 'host-thread' });
    useActiveExecutionStore.getState().reset();
    seed([run]);
    mocks.apiFetch.mockReset();
    mocks.cancel.mockReset();
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => valid });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    clearExecutionDetailRequest();
    vi.unstubAllGlobals();
  });
  async function open() {
    await act(async () => root.render(<HomeLiveCard threadId="host-thread" onSelectExecution={vi.fn()} />));
    await act(async () => requestExecutionDetail(run));
  }
  it('reads the exact task, retains raw command/start/source and cancels that task only', async () => {
    await open();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/callbacks/hold-ball/hold-exact/status');
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')?.textContent).toContain(
      valid.lifecycle.managedCommand.command,
    );
    expect(host.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(run.startedAt).toISOString());
    expect(host.querySelector('[data-testid="workspace-execution-detail"] a')?.getAttribute('href')).toBe(
      '/thread/thread-command-source',
    );
    const stop = host.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
    );
    await act(async () => stop?.click());
    expect(mocks.cancel).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const confirm = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === '停止',
    );
    await act(async () => confirm?.click());
    expect(mocks.cancel).toHaveBeenCalledWith(run);
  });
  it('uses the nameplate nickname/model and Chinese 24-hour time, with one Stop control', async () => {
    await open();
    expect(host.querySelector('[data-testid="workspace-running-object"] .home-live-name')?.textContent).toBe(
      '小太阳·砚砚',
    );
    expect(host.querySelector('time')?.textContent).not.toMatch(/AM|PM/);
    expect(
      [...host.querySelectorAll('[data-testid="workspace-execution-detail"] dt')].map((node) => node.textContent),
    ).not.toContain('停止');
  });
  it('names the Stop action and confirmation in the selected language without internal execution ids', async () => {
    await open();
    const stop = host.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
    );
    expect(stop?.getAttribute('aria-label')).toBe('停止小太阳·砚砚 · GPT-6.1 Sol的全量门禁');
    await act(async () => stop?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止全量门禁？');
  });
  it('Escape dismisses Stop confirmation while keeping this execution detail open', async () => {
    await open();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
        )
        ?.click(),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).not.toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('never stops a replacement generation after confirmation was opened', async () => {
    await open();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
        )
        ?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => seed([{ ...run, startedAt: run.startedAt + 1 }]));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('读不到这次执行的位置');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('consumes confirmation Escape before the original mobile window owner', async () => {
    const closeMobileWorkspace = vi.fn();
    window.addEventListener('keydown', closeMobileWorkspace);
    try {
      await open();
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
          )
          ?.click(),
      );
      await act(async () =>
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(closeMobileWorkspace).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', closeMobileWorkspace);
    }
  });
  it('returns focus to this detail when its original Stop control becomes unavailable', async () => {
    await open();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
      )
      ?.focus();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-execution-detail"] button:is([aria-label^="停止"], [aria-label^="Stop "])',
        )
        ?.click(),
    );
    await act(async () => seed([{ ...run, cancelability: { state: 'not_cancelable', reason: 'terminalizing' } }]));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')?.contains(document.activeElement)).toBe(
      true,
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('keeps the original non-cancelable reason visible in the selected language', async () => {
    writeShellLanguage('en');
    seed([{ ...run, cancelability: { state: 'not_cancelable', reason: 'foreign_principal' } }]);
    await open();
    const detail = host.querySelector('[data-testid="workspace-execution-detail"]');
    expect(detail?.textContent).toContain('Started by a schedule; you are not the initiator');
    expect(detail?.querySelector('button:is([aria-label^="停止"], [aria-label^="Stop "])')).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([
    { taskId: 'other-task' },
    { catId: 'other-cat' },
    { access: { lifecycleVisibility: 'status_only' } },
    { lifecycle: { managedCommand: { ...valid.lifecycle.managedCommand, startedAt: run.startedAt + 1 } } },
  ])('says unavailable for identity/authority drift %j without substituting a task', async (over) => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ...valid, ...over }) });
    await open();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')?.textContent).toContain(
      '读不到这次执行的位置',
    );
    expect(host.querySelector('[data-testid="workspace-execution-detail"] pre')).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([403, 404, 503])('shows unavailable for a %i response', async (status) => {
    mocks.apiFetch.mockResolvedValue({ ok: false, status });
    await open();
    expect(host.textContent).toContain('读不到这次执行的位置');
  });
  it('never displays a stale command after canonical completion', async () => {
    await open();
    await act(async () => useActiveExecutionStore.getState().reset());
    expect(host.textContent).toContain('读不到这次执行的位置');
    expect(host.querySelector('[data-testid="workspace-execution-detail"] pre')).toBeNull();
  });
  it('Esc closes the exact detail and returns its focus', async () => {
    await open();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).toBeNull();
  });
  it('leaves Escape to a focused original overlay without a dialog role', async () => {
    await open();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).not.toBeNull();
    input.remove();
  });
  it('leaves Esc to a subsequently opened dialog owner', async () => {
    await open();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.append(input);
    document.body.append(dialog);
    input.focus();
    const closeDialog = vi.fn();
    document.addEventListener('keydown', closeDialog);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closeDialog).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).not.toBeNull();
    document.removeEventListener('keydown', closeDialog);
    dialog.remove();
  });
  it('leaves Escape to the actual input-history owner', async () => {
    await open();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <>
          <HomeLiveCard threadId="host-thread" />
          <HistorySearchModal onSelect={vi.fn()} onClose={onClose} />
        </>,
      ),
    );
    const input = host.querySelector('input');
    await act(async () => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).not.toBeNull();
  });
  it('leaves Escape to the actual Steer owner even before it moves focus', async () => {
    await open();
    const onCancel = vi.fn();
    await act(async () =>
      root.render(
        <>
          <HomeLiveCard threadId="host-thread" />
          <SteerQueuedEntryModal onCancel={onCancel} onConfirm={vi.fn()} />
        </>,
      ),
    );
    await act(async () =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onCancel).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="workspace-execution-detail"]')).not.toBeNull();
  });
  it('does not pair the old command with another generation source or stop control', async () => {
    await open();
    mocks.apiFetch.mockImplementation(() => new Promise(() => {}));
    await act(async () =>
      useActiveExecutionStore.setState({
        executionsByKey: {
          [activeExecutionKey(run)]: {
            ...run,
            startedAt: run.startedAt + 1,
            threadId: 'thread-other-generation',
            catId: 'other-cat',
          },
        },
      }),
    );
    const detail = host.querySelector('[data-testid="workspace-execution-detail"]');
    expect(detail?.textContent).toContain('读不到这次执行的位置');
    expect(detail?.querySelector('pre')).toBeNull();
    expect(detail?.querySelector('button:is([aria-label^="停止"], [aria-label^="Stop "])')).toBeNull();
  });
});
