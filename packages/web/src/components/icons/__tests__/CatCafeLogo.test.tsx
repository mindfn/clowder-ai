import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatCafeLogo } from '../CatCafeLogo';

const ICON_DIR = resolve(process.cwd(), 'public/icons');

describe('CatCafeLogo', () => {
  it('renders the transparent three-cat PWA icon in the conversation header', () => {
    const html = renderToStaticMarkup(<CatCafeLogo className="h-16 w-auto" />);

    expect(html).toContain('src="/icons/icon-512x512.png"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="h-16 w-auto"');
    expect(html).not.toContain('<svg');
  });

  for (const [name, size] of [
    ['icon-192x192.png', 192],
    ['icon-512x512.png', 512],
    ['apple-touch-icon.png', 180],
  ] as const) {
    it(`${name} is a square RGBA PNG with the declared size`, () => {
      const bytes = readFileSync(resolve(ICON_DIR, name));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
      expect(bytes[25]).toBe(6);
    });
  }

  it('keeps the SVG favicon transparent and uses the canonical terracotta palette', () => {
    const favicon = readFileSync(resolve(ICON_DIR, 'favicon.svg'), 'utf8');

    expect(favicon).toContain('id="clowder-terracotta"');
    expect(favicon).toContain('fill="url(#clowder-terracotta)"');
    expect(favicon).not.toContain('fill="#000000"');
    expect(favicon).not.toContain('<rect');
  });
});
