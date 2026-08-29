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

  it('uses the canonical transparent three-cat silhouette as a real SVG favicon', () => {
    const favicon = readFileSync(resolve(ICON_DIR, 'favicon.svg'), 'utf8');

    expect(favicon).toContain('viewBox="0 0 1254 1254"');
    expect(favicon).toContain('id="clowder-three-cat-silhouette"');
    expect(favicon).toContain('<path');
    expect(favicon).not.toContain('<image');
    expect(favicon).not.toContain('<rect');
    expect(favicon).not.toContain('viewBox="0 0 640 640"');
  });
});
