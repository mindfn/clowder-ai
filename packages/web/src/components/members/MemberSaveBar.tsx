'use client';
import { type RefObject, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HubCatEditorController } from '../useHubCatEditor';
import { useMembersCopy, useMemberText } from './editor-presentation';

export function MemberSaveBar({
  editor: e,
  creating,
  anchor,
  onSave,
}: {
  editor: HubCatEditorController;
  creating: boolean;
  anchor: RefObject<HTMLDivElement>;
  onSave: () => void;
}) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const [bounds, setBounds] = useState<{ left: number; width: number; visible: boolean } | null>(null);
  useEffect(() => {
    const host = anchor.current?.closest<HTMLElement>('[data-trajectory-origin-scroll]');
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const next = {
        left: (left + right) / 2,
        width: Math.max(0, right - left - 24),
        visible: rect.width > 0 && rect.height > 0 && right > left && getComputedStyle(host).visibility !== 'hidden',
      };
      setBounds((previous) =>
        previous?.left === next.left && previous?.width === next.width && previous?.visible === next.visible
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    // Moves and keep-alive visibility can change without resizing the scroll host.
    const ancestors = new MutationObserver(measure);
    for (let element: HTMLElement | null = host; element; element = element.parentElement) {
      ancestors.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      ancestors.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [anchor]);
  // Workspace floats translate their host. Keep viewport coordinates out of that containing block.
  if (typeof document === 'undefined' || bounds?.visible === false) return null;
  return createPortal(
    <section
      className="members-v2 member-save-bar"
      aria-label={t('未保存修改')}
      style={bounds ? { left: bounds.left, maxWidth: bounds.width } : undefined}
    >
      <span>{creating ? t('添加后默认启用，可以在列表里关掉') : copy.changes(e.dirtyCount)}</span>
      <button
        type="button"
        className="member-button"
        disabled={e.saving}
        onClick={() => (creating ? void e.requestClose() : e.discard())}
      >
        {creating ? t('取消') : t('放弃')}
      </button>
      <button
        type="button"
        className="member-button member-primary"
        disabled={e.saving || e.restoringCloudIdentity || e.saveBlockedByProfileBinding}
        onClick={onSave}
      >
        {e.saving ? t('保存中…') : creating ? t('添加') : t('保存')}
      </button>
    </section>,
    document.body,
  );
}
