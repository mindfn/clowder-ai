import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureMessageScrollAnchor,
  highlightMessage,
  restoreMessageScrollAnchor,
  scrollToMessage,
} from '@/utils/scrollToMessage';

// jsdom doesn't provide CSS.escape — polyfill for tests
beforeAll(() => {
  if (!globalThis.CSS) {
    (globalThis as Record<string, unknown>).CSS = {};
  }
  if (!CSS.escape) {
    CSS.escape = (value: string) => value.replace(/([^\w-])/g, '\\$1');
  }
});

describe('scrollToMessage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures the first visible message relative to the scroll viewport', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const above = document.createElement('div');
    above.dataset.messageViewportId = 'above';
    above.getBoundingClientRect = () => ({ top: 0, bottom: 80 }) as DOMRect;
    const visible = document.createElement('div');
    visible.dataset.messageViewportId = 'visible';
    visible.getBoundingClientRect = () => ({ top: 76, bottom: 260 }) as DOMRect;
    container.append(above, visible);
    document.body.appendChild(container);

    expect(captureMessageScrollAnchor(container)).toEqual({
      messageId: 'visible',
      viewportOffsetPx: -24,
    });
  });

  it('restores the same message-relative position after predecessor geometry changes', () => {
    const container = document.createElement('div');
    container.scrollTop = 400;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const targetBoundary = document.createElement('div');
    targetBoundary.dataset.messageViewportId = 'target';
    targetBoundary.getBoundingClientRect = () =>
      ({ top: 680 - container.scrollTop, bottom: 920 - container.scrollTop }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'target';
    targetBoundary.appendChild(target);
    container.appendChild(targetBoundary);
    document.body.appendChild(container);

    expect(
      restoreMessageScrollAnchor(container, {
        messageId: 'target',
        viewportOffsetPx: 20,
      }),
    ).toBe(true);
    expect(container.scrollTop).toBe(560);
  });

  it('waits when the browser clamps a mounted anchor behind a short layout', () => {
    const container = document.createElement('div');
    let top = 200;
    let maxTop = 400;
    Object.defineProperty(container, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, maxTop);
      },
    });
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'target';
    boundary.getBoundingClientRect = () => ({ top: 700 - top, bottom: 900 - top }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'target';
    boundary.appendChild(target);
    container.appendChild(boundary);
    const anchor = { messageId: 'target', viewportOffsetPx: 0 };
    expect(restoreMessageScrollAnchor(container, anchor)).toBe(false);
    maxTop = 800;
    expect(restoreMessageScrollAnchor(container, anchor)).toBe(true);
    expect(top).toBe(600);
  });

  it('does not certify an anchor when rendering changes its boundary during the scroll write', () => {
    const container = document.createElement('div');
    let top = 200;
    let contentTop = 900;
    let renderedPredecessor = false;
    Object.defineProperty(container, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = value;
        if (!renderedPredecessor) {
          renderedPredecessor = true;
          contentTop += 120;
        }
      },
    });
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'target';
    boundary.getBoundingClientRect = () => ({ top: contentTop - top, bottom: contentTop + 200 - top }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'target';
    boundary.appendChild(target);
    container.appendChild(boundary);
    const anchor = { messageId: 'target', viewportOffsetPx: 0 };

    expect(restoreMessageScrollAnchor(container, anchor)).toBe(false);
    expect(boundary.getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(120);
    expect(restoreMessageScrollAnchor(container, anchor)).toBe(true);
    expect(boundary.getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(0);
  });

  it('scrolls to the element with matching data-message-id', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-123');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-123');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
  });

  it.each([
    400, 600, 3500,
  ])('keeps the beginning visible for a %ipx message in the original reading viewport', (height) => {
    const viewport = document.createElement('main');
    Object.defineProperty(viewport, 'clientHeight', { value: 600 });
    const target = document.createElement('article');
    target.dataset.messageId = 'sized';
    target.getBoundingClientRect = () => ({ height }) as DOMRect;
    target.scrollIntoView = vi.fn();
    viewport.append(target);
    document.body.append(viewport);
    expect(scrollToMessage('sized', viewport)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: height > 600 ? 'start' : 'center',
    });
  });
  it('adds highlight classes then removes after timeout', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-456');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-456');

    expect(el.classList.contains('ring-2')).toBe(true);
    expect(el.classList.contains('ring-blue-400')).toBe(true);

    vi.advanceTimersByTime(1500);

    expect(el.classList.contains('ring-2')).toBe(false);
    expect(el.classList.contains('ring-blue-400')).toBe(false);

    vi.useRealTimers();
  });

  it('does nothing when element is not found', () => {
    // Should not throw
    scrollToMessage('nonexistent-id');
  });

  it('lets the reading owner defer highlighting until arrival without starting an expiry timer', () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement('div');
      el.dataset.messageId = 'late';
      el.scrollIntoView = vi.fn();
      document.body.append(el);
      expect(scrollToMessage('late', document, 'smooth', false)).toBe(true);
      expect(el.classList.contains('ring-blue-400')).toBe(false);
      vi.advanceTimersByTime(1800);
      const cancel = highlightMessage('late');
      expect(el.classList.contains('ring-blue-400')).toBe(true);
      vi.advanceTimersByTime(1499);
      expect(el.classList.contains('ring-blue-400')).toBe(true);
      cancel?.();
      expect(el.classList.contains('ring-blue-400')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a newer activation and another surface intact when an older highlight is cancelled', () => {
    vi.useFakeTimers();
    try {
      const surfaces = [document.createElement('main'), document.createElement('main')];
      const targets = surfaces.map((surface) => {
        const target = document.createElement('article');
        target.dataset.messageId = 'source';
        surface.append(target);
        document.body.append(surface);
        return target;
      });
      const old = highlightMessage('source', surfaces[0]);
      highlightMessage('source', surfaces[1]);
      vi.advanceTimersByTime(1000);
      const current = highlightMessage('source', surfaces[0]);
      old?.();
      expect(targets.every((target) => target.classList.contains('ring-blue-400'))).toBe(true);
      vi.advanceTimersByTime(500);
      expect(targets[0].classList.contains('ring-blue-400')).toBe(true);
      expect(targets[1].classList.contains('ring-blue-400')).toBe(false);
      current?.();
      expect(targets[0].classList.contains('ring-blue-400')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an earlier immediate timer erase a later owner-settled highlight', () => {
    vi.useFakeTimers();
    try {
      const target = document.createElement('article');
      target.dataset.messageId = 'mode-switch-source';
      target.scrollIntoView = vi.fn();
      document.body.append(target);
      scrollToMessage('mode-switch-source');
      vi.advanceTimersByTime(1000);
      highlightMessage('mode-switch-source');
      vi.advanceTimersByTime(500);
      expect(target.classList.contains('ring-blue-400')).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(target.classList.contains('ring-blue-400')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an immediate navigation its original interval after cancelling an owner-settled activation', () => {
    vi.useFakeTimers();
    try {
      const target = document.createElement('article');
      target.dataset.messageId = 'return-classic-source';
      target.scrollIntoView = vi.fn();
      document.body.append(target);
      highlightMessage('return-classic-source');
      vi.advanceTimersByTime(1000);
      scrollToMessage('return-classic-source');
      vi.advanceTimersByTime(500);
      expect(target.classList.contains('ring-blue-400')).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(target.classList.contains('ring-blue-400')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns true when the target element is found (lets callers retry until DOM is ready)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-789');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    expect(scrollToMessage('msg-789')).toBe(true);
  });

  it('returns false when no matching element exists', () => {
    expect(scrollToMessage('missing-id')).toBe(false);
  });

  it('temporarily reveals a folded source return anchor only after navigation hits it', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-folded');
    el.setAttribute('data-folded-source-anchor', 'child-1');
    el.setAttribute('aria-hidden', 'true');
    el.className = 'h-0 overflow-hidden';
    el.scrollIntoView = vi.fn();
    const affordance = document.createElement('button');
    affordance.hidden = true;
    affordance.setAttribute('data-folded-source-affordance', '');
    affordance.textContent = '该补充已归入上方回复';
    el.appendChild(affordance);
    document.body.appendChild(el);

    expect(affordance.hidden).toBe(true);
    expect(scrollToMessage('msg-folded')).toBe(true);
    expect(affordance.hidden).toBe(false);
    expect(el.getAttribute('aria-hidden')).toBe('false');

    vi.advanceTimersByTime(3200);
    expect(affordance.hidden).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    vi.useRealTimers();
  });
});
