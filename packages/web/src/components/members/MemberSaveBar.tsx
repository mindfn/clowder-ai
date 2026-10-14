'use client';
import { type RefObject, useEffect, useState } from 'react';
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
  const [bounds, setBounds] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const host = anchor.current?.closest<HTMLElement>('[data-trajectory-origin-scroll]');
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const next = { left: rect.left + rect.width / 2, width: Math.max(0, rect.width - 24) };
      setBounds((previous) => (previous?.left === next.left && previous?.width === next.width ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [anchor]);
  return (
    <section
      className="member-save-bar"
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
    </section>
  );
}
