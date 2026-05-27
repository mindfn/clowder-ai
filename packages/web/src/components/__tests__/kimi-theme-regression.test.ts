// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const catPersonaTokensCssPath = resolve(webRoot, 'src', 'app', 'cat-persona-tokens.css');
const tailwindConfigPath = resolve(webRoot, 'tailwind.config.js');

describe('kimi theme regression', () => {
  it('keeps Kimi CSS tokens defined as a low-chroma neutral 梵花猫 (F056 Phase E OKLCH)', () => {
    const css = readFileSync(catPersonaTokensCssPath, 'utf8');
    expect(css).toContain('--color-kimi-primary');
    expect(css).toContain('--color-kimi-light');
    expect(css).toContain('--color-kimi-dark');
    expect(css).toContain('--color-kimi-bg');
    expect(css).toMatch(/--kimi-chroma:\s*0\.0\d/);
    expect(css).not.toContain('#7c3aed');
  });

  it('exports a kimi color family in tailwind so sidebar/session-chain classes compile', async () => {
    const configModule = await import(tailwindConfigPath);
    const config = configModule.default ?? configModule;
    expect(config.theme.extend.colors.kimi).toEqual({
      primary: 'var(--color-kimi-primary)',
      light: 'var(--color-kimi-light)',
      dark: 'var(--color-kimi-dark)',
      bg: 'var(--color-kimi-bg)',
    });
  });
});
