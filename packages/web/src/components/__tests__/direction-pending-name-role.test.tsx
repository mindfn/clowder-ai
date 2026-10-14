import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { DirectionPill } from '../DirectionPill';
import { PendingMemberBubble } from '../PendingMemberBubble';

Object.assign(globalThis as Record<string, unknown>, { React });

const shell = vi.hoisted(() => ({ presentation: 'classic' as 'classic' | 'v2', language: 'zh' as 'zh' | 'en' }));
const catsById = vi.hoisted(() => ({
  current: {} as Record<string, { id: string; displayName: string; color: { primary: string; secondary: string } }>,
}));

vi.mock('@/components/shell/shell-presentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/shell-presentation')>()),
  useShellPresentation: () => shell.presentation,
}));

vi.mock('@/components/shell/shell-language', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/shell-language')>()),
  useShellLanguage: () => shell.language,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => catsById.current[id] }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ status }: { status?: string }) =>
    React.createElement('span', { 'data-testid': 'cat-avatar', 'data-status': status ?? '' }, 'avatar'),
}));

/**
 * F322 B — the direction pill ("→ @猫名") and the member-pending bubble in the new shell. Classic is frozen: its markup must
 * not move by a byte. Static markup, so the raw `style` strings are visible (jsdom drops an eight-digit hex background); the
 * shell presentation and language hooks are the only things controlled here.
 *
 * Direction pill, new shell: a cat's name is written in its readable name role with the 12.5% identity tint behind it. A target
 * with no cat behind it (an id the catalogue does not know, a cross-thread pointer) is not a cat, so it carries no cat colour:
 * the body text role on the neutral surface-3 base (`--shell-body` on `--shell-selected`); the arrow stays.
 *
 * Pending bubble, new shell: it is the same nameplate as the real reply that replaces it, with one line under it,
 * 「已开始，还没有输出」 / "Started, no output yet"; no avatar column, no dots. A cat the catalogue does not know gets the
 * name in the body role, without a plate.
 */
const opus: CatData = {
  id: 'opus',
  displayName: '宪宪',
  color: { primary: '#8B5CF6', secondary: '#7C3AED' },
} as CatData;
const getCatById = (id: string) => (id === 'opus' ? opus : undefined);

const direction = { type: 'mention' as const, targets: ['opus'], arrow: '→' as const };
const pill = (d: typeof direction | { type: 'crossPost'; targets: string[]; arrow: '↗' }, lookup = getCatById) =>
  renderToStaticMarkup(<DirectionPill direction={d as never} getCatById={lookup} />);
const styleOfFirstElement = (html: string) => /style="([^"]*)"/.exec(html)?.[1];
const NEUTRAL = 'background-color:var(--shell-selected);color:var(--shell-body)';

const pending = (catId = 'opus', props: Partial<React.ComponentProps<typeof PendingMemberBubble>> = {}) =>
  renderToStaticMarkup(<PendingMemberBubble catId={catId} invocationId="inv-1" {...props} />);
const attrsOf = (html: string, testId: string) =>
  new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';
const styleOf = (tag: string) => /style="([^"]*)"/.exec(tag)?.[1];
const textOf = (html: string, testId: string) =>
  new RegExp(`data-testid="${testId}"[^>]*>(.*?)</`).exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? null;

describe('DirectionPill', () => {
  describe('classic is byte-identical: the cat is written in its own hex', () => {
    it('known cat', () => {
      shell.presentation = 'classic';
      expect(styleOfFirstElement(pill(direction))).toBe('background-color:#8B5CF620;color:#8B5CF6');
    });

    it('unknown target and a cross-post keep the fallback colour', () => {
      shell.presentation = 'classic';
      expect(styleOfFirstElement(pill({ ...direction, targets: ['ghost'] }))).toBe(
        'background-color:#9B7EBD20;color:#9B7EBD',
      );
      expect(styleOfFirstElement(pill({ type: 'crossPost', targets: ['thread-a'], arrow: '↗' }))).toBe(
        'background-color:#9B7EBD20;color:#9B7EBD',
      );
    });
  });

  describe('new shell', () => {
    it('known cat: --color-{cat}-text for the words, the cat hex at 12.5% behind them', () => {
      shell.presentation = 'v2';
      expect(styleOfFirstElement(pill(direction))).toBe('background-color:#8B5CF620;color:var(--color-opus-text)');
    });

    it('the words and the arrow do not change', () => {
      shell.presentation = 'v2';
      expect(pill(direction)).toContain('→ @宪宪');
      expect(pill({ type: 'crossPost', targets: ['abcdef12'], arrow: '↗' })).toContain('↗ abcdef12');
      expect(pill({ ...direction, targets: ['ghost'] })).toContain('→ @ghost');
    });

    it('unknown target: no cat colour anywhere, the body text role on the neutral base', () => {
      shell.presentation = 'v2';
      expect(styleOfFirstElement(pill({ ...direction, targets: ['ghost'] }))).toBe(NEUTRAL);
    });

    it('a cross-thread pointer: the same neutral pill, with its arrow kept as the sign that it is cross-thread', () => {
      shell.presentation = 'v2';
      const html = pill({ type: 'crossPost', targets: ['abcdef12'], arrow: '↗' });
      expect(styleOfFirstElement(html)).toBe(NEUTRAL);
      expect(html).toContain('↗');
    });

    it('a catalogued cat whose id is not CSS-safe still points at the same token the message name uses', () => {
      shell.presentation = 'v2';
      const odd = (id: string) =>
        id === 'odd id'
          ? ({ id, displayName: '怪', color: { primary: '#123456', secondary: '#654321' } } as CatData)
          : undefined;
      // catSlug() sends an unsafe id to the co-creator token rather than to a var() that does not exist.
      expect(styleOfFirstElement(pill({ ...direction, targets: ['odd id'] }, odd))).toBe(
        'background-color:#12345620;color:var(--color-cocreator-text)',
      );
    });
  });
});

describe('PendingMemberBubble', () => {
  describe('classic is byte-identical', () => {
    it('known cat: the cat hex at 0.8 opacity, an avatar column, three dots and no nameplate', () => {
      shell.presentation = 'classic';
      catsById.current = { opus };
      const html = pending();
      expect(html).toContain('style="color:#8B5CF6;opacity:0.8"');
      expect(html.match(/data-testid="cat-avatar"/g)).toHaveLength(1);
      expect(html.match(/animate-bounce/g)).toHaveLength(3);
      expect(html).not.toContain('cat-nameplate');
      expect(html).not.toContain('pending-member-status');
    });

    it('unknown cat: no colour, still 0.8', () => {
      shell.presentation = 'classic';
      catsById.current = {};
      expect(pending('ghost')).toContain('<span class="text-xs font-semibold" style="opacity:0.8">ghost</span>');
    });
  });

  describe('new shell: the same nameplate as the reply that replaces it, and one line under it', () => {
    it('a known cat is a nameplate in its role colours; the name is the cat name role at full opacity', () => {
      shell.presentation = 'v2';
      shell.language = 'zh';
      catsById.current = { opus };
      const html = pending();
      const plate = attrsOf(html, 'cat-nameplate');
      expect(plate).toContain('data-cat-id="opus"');
      expect(styleOf(attrsOf(html, 'cat-nameplate-name'))).toBe('color:var(--color-opus-text)');
      expect(textOf(html, 'cat-nameplate-name')).toBe('宪宪');
    });

    it('uses the reply nameplate avatar and reports the pending state on the separate status line', () => {
      shell.presentation = 'v2';
      catsById.current = { opus };
      const html = pending();
      expect(html.match(/data-testid="cat-avatar"/g)).toHaveLength(1);
      expect(attrsOf(html, 'cat-nameplate-avatar')).toContain('absolute left-0');
      expect(textOf(html, 'pending-member-status')).toContain('已开始，还没有输出');
      expect(html).not.toContain('animate-bounce');
      expect(html).not.toContain('text-xs font-semibold');
    });

    it('sits like a real reply: the nameplate presentation of the bubble, unframed, left edge at the reading column', () => {
      shell.presentation = 'v2';
      catsById.current = { opus };
      const html = pending();
      expect(html).toContain('data-message-id="pending-inv-1"');
      expect(html).toContain('max-w-full'); // the nameplate presentation's column, not the 75% bubble column
      expect(html).not.toContain('px-4 py-3');
    });

    it('writes 「已开始，还没有输出」 under the plate, with a grey dot', () => {
      shell.presentation = 'v2';
      shell.language = 'zh';
      catsById.current = { opus };
      const html = pending();
      expect(textOf(html, 'pending-member-status')).toContain('已开始，还没有输出');
      expect(html.indexOf('cat-nameplate')).toBeLessThan(html.indexOf('pending-member-status'));
      expect(html).toContain('data-testid="pending-member-status-dot"');
    });

    it('says it in English when the language is English', () => {
      shell.presentation = 'v2';
      shell.language = 'en';
      catsById.current = { opus };
      expect(textOf(pending(), 'pending-member-status')).toContain('Started, no output yet');
      shell.language = 'zh';
    });

    it('a cat the catalogue does not know: its name in the body text role, no plate, and the same line', () => {
      shell.presentation = 'v2';
      shell.language = 'zh';
      catsById.current = {};
      const html = pending('ghost');
      expect(html).not.toContain('cat-nameplate');
      expect(html).toContain('ghost');
      expect(html).toMatch(/style="color:var\(--shell-body\)"/);
      expect(textOf(html, 'pending-member-status')).toContain('已开始，还没有输出');
    });

    it('a catalogued cat whose id is not CSS-safe points at the same token the message name uses', () => {
      shell.presentation = 'v2';
      catsById.current = {
        'odd id': { id: 'odd id', displayName: '怪', color: { primary: '#123456', secondary: '#654321' } },
      };
      expect(styleOf(attrsOf(pending('odd id'), 'cat-nameplate-name'))).toBe('color:var(--color-cocreator-text)');
    });
  });
});
