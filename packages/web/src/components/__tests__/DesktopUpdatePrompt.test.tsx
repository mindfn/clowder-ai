import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DesktopUpdatePrompt } from '../DesktopUpdatePrompt';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('DesktopUpdatePrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let promptListener: ((prompt: DesktopUpdatePromptPayload) => void) | undefined;
  let unsubscribe: Mock<() => void>;
  let unsubscribeProgress: Mock<() => void>;
  let ready: Mock<() => void>;
  let sendAction: Mock<(action: DesktopUpdatePromptAction, version: string) => void>;
  let progressListener: ((progress: DesktopUpdateProgressPayload | null) => void) | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    unsubscribe = vi.fn();
    unsubscribeProgress = vi.fn();
    ready = vi.fn();
    sendAction = vi.fn();
    window.desktopBridge = {
      onStatus: () => () => {},
      onUpdatePrompt: (listener) => {
        promptListener = listener;
        return unsubscribe;
      },
      onUpdateProgress: (listener) => {
        progressListener = listener;
        return unsubscribeProgress;
      },
      updatePromptReady: ready,
      sendUpdatePromptAction: sendAction,
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete window.desktopBridge;
    vi.clearAllMocks();
  });

  function renderPrompt() {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        version: '0.12.0',
        currentVersion: '0.10.0',
        platform: 'windows',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
      });
    });
  }

  it('requests pending-prompt replay and cleans up its subscription', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    expect(ready).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('recommends only the selected Windows installer and links the exact release', () => {
    renderPrompt();

    expect(container.querySelector('[role="dialog"]')?.className).toContain('max-w-lg');
    expect(container.textContent).toContain('Recommended for Windows');
    expect(container.textContent).toContain('ClowderAI-Setup-0.12.0.exe');
    expect(container.textContent).not.toContain('.dmg');
    expect(container.textContent).not.toContain('Downloads');

    const releaseLink = container.querySelector('[data-testid="desktop-update-release-link"]') as HTMLAnchorElement;
    expect(releaseLink.textContent).toBe('v0.12.0');
    expect(releaseLink.href).toBe('https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0');

    act(() => releaseLink.click());
    expect(sendAction).toHaveBeenCalledWith('open-release', '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('recommends only the selected macOS architecture image', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        version: '0.12.0',
        currentVersion: '0.10.0',
        platform: 'macos',
        assetName: 'ClowderAI-0.12.0-arm64.dmg',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
      });
    });

    expect(container.textContent).toContain('Recommended for macOS');
    expect(container.textContent).toContain('ClowderAI-0.12.0-arm64.dmg');
    expect(container.textContent).not.toContain('.exe');
    expect(
      Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Download macOS DMG'),
    ).toBe(true);
  });

  it.each([
    ['Download Windows Setup', 'download'],
    ['Later', 'later'],
    ['Skip This Version', 'skip'],
  ] as const)('sends %s as a version-bound terminal action', (label, action) => {
    renderPrompt();
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);

    act(() => button?.click());

    expect(sendAction).toHaveBeenCalledWith(action, '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders nothing in an ordinary browser without the desktop bridge', () => {
    delete window.desktopBridge;
    act(() => root.render(<DesktopUpdatePrompt />));
    expect(container.textContent).toBe('');
  });

  it('shows one draggable in-app progress card with the selected asset and percentage', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.42,
      });
    });

    const card = container.querySelector('[data-testid="desktop-update-progress"]');
    const bar = container.querySelector('[role="progressbar"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Downloading update');
    expect(card?.textContent).toContain('ClowderAI-Setup-0.12.0.exe');
    expect(card?.textContent).toContain('42%');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(container.querySelector('[data-testid="desktop-update-progress-rnd"]')).toBeTruthy();
  });

  it('collapses or hides only the projection while the main-owned transfer keeps updating', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.2,
      });
    });

    const collapse = container.querySelector('[aria-label="Collapse download progress"]') as HTMLButtonElement;
    act(() => collapse.click());
    expect(container.querySelector('[data-testid="desktop-update-progress"]')?.textContent).toContain('20%');
    expect(container.querySelector('[data-testid="desktop-update-progress-details"]')).toBeNull();

    const hide = container.querySelector(
      '[aria-label="Hide download progress; download continues"]',
    ) as HTMLButtonElement;
    act(() => hide.click());
    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();

    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.7,
      });
    });
    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('resurfaces a same-version retry after the previous transfer reaches idle', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    const transfer = {
      phase: 'downloading' as const,
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.2,
    };
    act(() => progressListener?.(transfer));
    const hide = container.querySelector(
      '[aria-label="Hide download progress; download continues"]',
    ) as HTMLButtonElement;
    act(() => hide.click());

    act(() => progressListener?.(null));
    act(() => progressListener?.({ ...transfer, progress: 0 }));

    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeTruthy();
    expect(container.textContent).toContain('0%');
  });
});
