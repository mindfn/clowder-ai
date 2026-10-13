'use client';

import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function composerPopoverPosition(
  rect: { top: number; left: number },
  width: number,
  height: number,
  preferredWidth = 300,
) {
  const panelWidth = Math.min(preferredWidth, width - 16);
  return {
    position: 'fixed' as const,
    width: panelWidth,
    left: Math.max(8, Math.min(rect.left, width - panelWidth - 8)),
    bottom: Math.max(8, height - rect.top + 6),
    maxHeight: Math.max(64, Math.min(rect.top - 14, height - 16)),
  };
}

/** The composer stays at the bottom; its controls open into the space above it. */
export function ComposerPopover({
  anchor,
  label,
  onClose,
  preferredWidth,
  presentation = 'v2',
  children,
}: {
  anchor: RefObject<HTMLButtonElement>;
  label: string;
  onClose: () => void;
  preferredWidth?: number;
  presentation?: 'classic' | 'v2';
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const trigger = anchor.current;
    panel.current?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')?.focus();
    const dismiss = (restoreFocus: boolean) => {
      closeRef.current();
      if (restoreFocus) trigger?.focus();
    };
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) dismiss(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss(true);
    };
    const resize = () => dismiss(true);
    const scroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) dismiss(false);
    };
    const blur = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) dismiss(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', blur);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', blur);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor]);
  const trigger = anchor.current;
  if (!trigger) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={composerPopoverPosition(
        trigger.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        preferredWidth,
      )}
      className={`z-[70] flex flex-col overflow-y-auto overscroll-contain ${
        presentation === 'classic'
          ? 'rounded-2xl bg-cafe-surface-canvas p-1.5 text-cafe-secondary shadow-xl'
          : 'rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] p-1 text-[var(--shell-body)] shadow-lg'
      }`}
    >
      {children}
    </div>,
    document.body,
  );
}
