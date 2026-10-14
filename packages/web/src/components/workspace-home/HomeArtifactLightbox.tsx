'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveAssetUrl } from '@/components/artifacts/artifact-view';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { API_URL } from '@/utils/api-client';
import { artifactObjectId } from '../workbench/real-surface-adapters';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

export function HomeArtifactLightbox({
  artifact,
  images,
  onSelect,
  onClose,
  onAnnotate,
  metadata,
  notice,
  artifactKey = artifactObjectId,
}: {
  artifact: ThreadArtifactDTO;
  images: readonly ThreadArtifactDTO[];
  onSelect: (artifact: ThreadArtifactDTO) => void;
  onClose: () => void;
  onAnnotate: () => void;
  metadata: string;
  notice?: string;
  artifactKey?: (artifact: ThreadArtifactDTO) => string;
}) {
  const t = useShellCopy(workspaceV3Copy);
  const language = useShellLanguage();
  const close = useRef<HTMLButtonElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const index = images.findIndex((item) => artifactKey(item) === artifactKey(artifact));
  const move = (offset: number) => {
    const next = images[index + offset];
    if (!next) return;
    onSelect(next);
  };
  const selectedId = artifactKey(artifact);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and catalogue position determine whether the previously focused paging control is still enabled.
  useLayoutEffect(() => {
    const dialog = close.current?.closest('[role="dialog"]');
    const active = document.activeElement;
    if (active && active !== document.body && !dialog?.contains(active)) return;
    const control = focusedControl.current;
    if (control && (!control.isConnected || (control instanceof HTMLButtonElement && control.disabled)))
      close.current?.focus();
  }, [selectedId, index, images.length]);
  const movement = useRef(move);
  movement.current = move;
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) =>
      handlePreviewKey(event, close.current?.closest('[role="dialog"]'), onClose, movement.current);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const url = resolveAssetUrl(artifact.url, API_URL);
  return createPortal(
    <div className="home-lightbox-backdrop" data-shell="v2" lang={language === 'zh' ? 'zh-CN' : 'en'}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={artifact.name}
        className="home-lightbox"
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) focusedControl.current = event.target;
        }}
      >
        <header>
          <span className="min-w-0 truncate text-sm">{artifact.name}</span>
          <button ref={close} type="button" className="shell-focusable" onClick={onClose} aria-label={t.close}>
            ×
          </button>
        </header>
        <div className="home-lightbox-image">
          {url && failedUrl !== url ? (
            // biome-ignore lint/performance/noImgElement: preserve the original publication URL without a second asset proxy.
            <img src={url} alt={artifact.name} onError={() => setFailedUrl(url)} />
          ) : (
            <output>{t.noPreview}</output>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="shell-focusable"
            disabled={index <= 0}
            onClick={() => move(-1)}
            aria-label={t.previous}
          >
            ‹
          </button>
          <span className="min-w-0 flex-1 text-xs">
            {metadata}
            {notice && <output className="block">{notice}</output>}
          </span>
          <button type="button" className="home-btn shell-focusable" onClick={onAnnotate}>
            {t.annotate}
          </button>
          <button
            type="button"
            className="shell-focusable"
            disabled={index < 0 || index >= images.length - 1}
            onClick={() => move(1)}
            aria-label={t.next}
          >
            ›
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function trapPreviewFocus(event: KeyboardEvent, dialog: Element | null | undefined) {
  const controls = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]');
  if (!controls?.length) return;
  const first = controls[0],
    last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handlePreviewKey(
  event: KeyboardEvent,
  dialog: Element | null | undefined,
  onClose: () => void,
  move: (offset: number) => void,
) {
  const targetDialog = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
  if (targetDialog && targetDialog !== dialog) return;
  const focus = document.activeElement;
  if (focus instanceof Element && focus !== document.body && !dialog?.contains(focus)) return;
  if (event.key === 'Escape') {
    event.stopImmediatePropagation();
    event.preventDefault();
    onClose();
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    move(event.key === 'ArrowLeft' ? -1 : 1);
  }
  if (event.key === 'Tab') trapPreviewFocus(event, dialog);
}
