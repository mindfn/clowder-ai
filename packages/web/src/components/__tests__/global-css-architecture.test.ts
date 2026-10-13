// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const appDir = resolve(webRoot, 'src', 'app');

describe('global css architecture', () => {
  it('loads split global css files from the root layout', () => {
    const layoutSource = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');

    /* globals.css is the only CSS still loaded via JS import */
    expect(layoutSource).toContain("import './globals.css';");

    /* All other token/control sheets are served as static <link> tags via /vendor/app/ */
    const vendorSheets = [
      'theme-tokens.css',
      'cat-persona-tokens.css',
      'cat-persona-derived.css',
      'connector-tokens.css',
      'theme-extras.css',
      'console-tokens.css',
      'console-shell.css',
      'console-controls.css',
      'shell-v2.css',
    ];
    for (const sheet of vendorSheets) {
      expect(layoutSource).toContain(`/vendor/app/${sheet}`);
    }
  });

  it('lets the new-conversation composer overlap its artwork without an opaque host rectangle', () => {
    const shellCss = readFileSync(resolve(appDir, 'shell-v2.css'), 'utf8');
    const landingComposerRule = shellCss.match(
      /\[data-testid="new-conversation-page"\][^{]*div:has\(> \[data-testid="chat-input-composer-row"\]\)\s*\{([^}]*)\}/u,
    );

    expect(landingComposerRule?.[1]).toContain('background: transparent');
  });
});
