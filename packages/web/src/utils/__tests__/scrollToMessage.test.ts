import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { captureMessageScrollAnchor, restoreMessageScrollAnchor, scrollToMessage } from '@/utils/scrollToMessage';

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
    targetBoundary.getBoundingClientRect = () => ({ top: 280, bottom: 520 }) as DOMRect;
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

  it('uses the shared message-jump marker and removes it after timeout', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-456');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-456');

    expect(el.dataset.messageJumpFocus).toBe('true');
    expect(el.classList.contains('ring-blue-400')).toBe(false);

    vi.advanceTimersByTime(3200);

    expect(el.dataset.messageJumpFocus).toBeUndefined();

    vi.useRealTimers();
  });

  it('uses the same marker for lineage jumps', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'lineage-msg');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    expect(focusLineageMessage('lineage-msg')).toBe(true);
    expect(el.dataset.messageJumpFocus).toBe('true');

    vi.advanceTimersByTime(3200);
    expect(el.dataset.messageJumpFocus).toBeUndefined();
    vi.useRealTimers();
  });

  it('renders the shared marker as an orange open-left bracket rather than a full outline', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const markerRule = css.match(/\[data-message-jump-focus="true"\]::after\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(markerRule).toContain('border: 2px solid var(--color-cocreator-primary)');
    expect(markerRule).toContain('border-left: 0');
    expect(markerRule).not.toContain('outline:');
  });

  it('does nothing when element is not found', () => {
    // Should not throw
    scrollToMessage('nonexistent-id');
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
