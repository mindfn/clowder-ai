import { type RefObject, useEffect } from 'react';

export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement>, input: string, placeholder?: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: React must commit the draft and displayed placeholder before measuring the DOM's scrollHeight.
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = 'auto';
      const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
      const maxHeight = isMobile ? 120 : 200;
      // scrollHeight includes padding but excludes our border-box textarea's border.
      const borderHeight = textarea.offsetHeight - textarea.clientHeight;
      textarea.style.height = `${Math.min(textarea.scrollHeight + borderHeight, maxHeight)}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    // Pane/sidebar resizing can change wrapping without changing the window or draft.
    const parent = textarea.parentElement;
    let parentWidth = parent?.clientWidth;
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || width === parentWidth) return;
            parentWidth = width;
            resize();
          })
        : null;
    if (parent) observer?.observe(parent);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
    };
  }, [ref, input, placeholder]);
}
