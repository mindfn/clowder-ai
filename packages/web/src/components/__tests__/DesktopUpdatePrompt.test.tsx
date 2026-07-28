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
  let ready: Mock<() => void>;
  let sendAction: Mock<(action: DesktopUpdatePromptAction, version: string) => void>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    unsubscribe = vi.fn();
    ready = vi.fn();
    sendAction = vi.fn();
    window.desktopBridge = {
      onStatus: () => () => {},
      onUpdatePrompt: (listener) => {
        promptListener = listener;
        return unsubscribe;
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
        releaseNotes: '# Highlights\n\n- **Rendered** notes\n\n<script>window.pwned = true</script>',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
      });
    });
  }

  it('requests pending-prompt replay and cleans up its subscription', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    expect(ready).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('renders release Markdown, a scrollable body, and a clickable exact-version link', () => {
    renderPrompt();

    expect(container.querySelector('h1')?.textContent).toBe('Highlights');
    expect(container.querySelector('strong')?.textContent).toBe('Rendered');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-update-notes"]')?.className).toContain('overflow-y-auto');

    const releaseLink = container.querySelector('[data-testid="desktop-update-release-link"]') as HTMLAnchorElement;
    expect(releaseLink.textContent).toBe('v0.12.0');
    expect(releaseLink.href).toBe('https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0');

    act(() => releaseLink.click());
    expect(sendAction).toHaveBeenCalledWith('open-release', '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it.each([
    ['Download', 'download'],
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
});
