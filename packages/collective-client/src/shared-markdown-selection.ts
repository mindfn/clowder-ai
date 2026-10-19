import { findGeneratedTextConstructs, projectMarkdownReadableTextWithSourceMap } from '@cat-cafe/shared';

export function sharedMarkdownDomSelection(paper: HTMLElement, event: Event, source: string) {
  if (!(event.target instanceof Node) || !paper.contains(event.target)) return undefined;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!paper.contains(range.commonAncestorContainer)) return undefined;
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>('[data-source-start]');
  const bounds = block ? { start: Number(block.dataset.sourceStart), end: Number(block.dataset.sourceEnd) } : undefined;
  return resolveSharedMarkdownSelection(source, selection.toString(), bounds);
}

/** Match only inside the rendered block's source interval; a repeated quote never silently selects its first occurrence. */
export function resolveSharedMarkdownSelection(
  source: string,
  selectedText: string,
  bounds = { start: 0, end: source.length },
) {
  const raw = source.slice(bounds.start, bounds.end);
  if (findGeneratedTextConstructs(raw).length) return null;
  const projection = projectMarkdownReadableTextWithSourceMap(raw);
  const selected = selectedText.trim().replace(/\s+/gu, ' ');
  if (!selected) return null;
  let readable = '';
  const offsets: (number | null)[] = [];
  for (let index = 0; index < projection.text.length; index++) {
    const character = projection.text[index] ?? '';
    if (/\s/u.test(character)) {
      if (readable.endsWith(' ')) continue;
      readable += ' ';
      offsets.push(null);
    } else {
      readable += character;
      offsets.push(projection.sourceOffsets[index] ?? null);
    }
  }
  const at = readable.indexOf(selected);
  if (at < 0 || readable.indexOf(selected, at + 1) >= 0) return null;
  const first = offsets[at],
    last = offsets[at + selected.length - 1];
  if (first == null || last == null) return null;
  return { start: bounds.start + first, end: bounds.start + last + 1 };
}
