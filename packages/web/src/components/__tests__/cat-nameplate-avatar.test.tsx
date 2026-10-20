import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { CatNameplate } from '../CatNameplate';

Object.assign(globalThis as Record<string, unknown>, { React });

const registry = vi.hoisted(() => ({ cats: [] as Array<{ id: string }> }));

// Use the real member avatar and registry so placement cannot hide a duplicate frame.
vi.mock('@/hooks/useCatData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatData')>();
  return {
    ...actual,
    useCatData: () => ({
      getCatById: (id: string) => registry.cats.find((cat) => cat.id === id),
      cats: registry.cats,
      refresh: () => {},
    }),
  };
});

const OPUS = {
  id: 'opus',
  displayName: '布偶猫',
  nickname: '宪宪',
  breedId: 'ragdoll',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  mentionPatterns: ['@opus'],
  clientId: 'anthropic',
  defaultModel: 'claude',
} as unknown as CatData;

/** Nameplate placement must not duplicate the shared member avatar body. */
const render = (props: Partial<React.ComponentProps<typeof CatNameplate>> = {}) => {
  registry.cats = [OPUS];
  return renderToStaticMarkup(<CatNameplate catId="opus" name="宪宪" {...props} />);
};
const attrsOf = (html: string, testId: string) =>
  new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';

describe('the nameplate carries a 32px face laid over its left end', () => {
  it('renders the accepted 26px plate with a 32px face below its edge through the shared CSS', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync('../ui/src/styles.css', 'utf8');
    document.head.append(style);
    const host = document.createElement('div');
    host.innerHTML = render();
    document.body.append(host);
    try {
      const plate = getComputedStyle(host.querySelector('[data-testid="cat-nameplate"]') as HTMLElement);
      const face = getComputedStyle(host.querySelector('[data-testid="cat-nameplate-avatar"]') as HTMLElement);
      const name = getComputedStyle(host.querySelector('[data-testid="cat-nameplate-name"]') as HTMLElement);
      expect(plate.height).toBe('26px');
      expect(plate.paddingLeft).toBe('40px');
      expect(plate.paddingRight).toBe('10px');
      expect(face.width).not.toBe('32px');
      expect(face.height).not.toBe('32px');
      expect(face.bottom).toBe('-2px');
      expect(face.boxShadow).not.toContain('0 0 0 2px');
      expect(name.fontSize).toBe('13px');
      expect(name.fontWeight).toBe('600');
      expect(name.textOverflow).toBe('ellipsis');
    } finally {
      host.remove();
      style.remove();
    }
  });

  it('fills the plate with the cat surface role, fading to transparent, as before', () => {
    expect(attrsOf(render(), 'cat-nameplate')).toContain(
      'linear-gradient(to bottom, var(--color-opus-surface), transparent)',
    );
  });

  it('delegates the full-size image and identity ring to the shared member body', () => {
    const html = render();
    const wrapper = attrsOf(html, 'cat-nameplate-avatar');
    expect(wrapper).not.toContain('box-shadow');
    expect(wrapper).not.toContain('rounded-full');
    const body = /<[^>]*data-sender-avatar="message"[^>]*>/.exec(html)?.[0] ?? '';
    expect(body).toContain('w-8 h-8');
    expect(body).not.toContain('box-shadow');
    expect(html).toContain('data-member-avatar-ring');
    expect(html).toContain('box-shadow:inset 0 0 0 1px #9B7EBD');
    expect(html).toContain('w-full h-full object-cover');
  });

  it('keeps the full name keyboard-accessible for the shared tooltip and consumes the cat name role', () => {
    const name = attrsOf(render({ title: '完整名字' }), 'cat-nameplate-name');
    expect(name).toContain('color:var(--color-opus-text)');
    expect(name).toContain('tabindex="0"');
    expect(name).not.toContain('title=');
  });

  it('keeps the v2 face still; observed activity belongs to the last line', () => {
    expect(render()).toContain('data-testid="cat-nameplate-avatar"');
    expect(render()).not.toContain('animate-pulse');
  });
});
