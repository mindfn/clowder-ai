/**
 * Site integrity regression tests.
 *
 * Covers: XSS hardening, link rewriting, local asset existence,
 * DOMPurify/marked pinning, and lang-toggle scoping.
 *
 * Run: node --test site/site-integrity.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SITE = resolve(dirname(new URL(import.meta.url).pathname));

function readSite(name) {
  return readFileSync(resolve(SITE, name), 'utf8');
}

// ─── P1: XSS hardening (community.html) ─────────────────────────────
describe('community.html XSS hardening', () => {
  const html = readSite('community.html');

  it('does not use inline onclick for issue rows', () => {
    // Issue data must not flow through onclick attributes
    assert.doesNotMatch(html, /onclick\s*=\s*["']showIssueDetail\(/, 'inline onclick with issue data is an XSS vector');
  });

  it('loads DOMPurify for sanitizing markdown output', () => {
    assert.match(html, /dompurify@[\d.]+/, 'DOMPurify must be loaded with a pinned version');
  });

  it('sanitizes marked output through DOMPurify', () => {
    assert.match(
      html,
      /DOMPurify\.sanitize\(\s*marked\.parse\(/,
      'marked.parse output must pass through DOMPurify.sanitize',
    );
  });

  it('looks up issue data from issueMap by number, not from inline attributes', () => {
    assert.match(html, /issueMap\.get\(/, 'issue detail should retrieve data from Map by number');
  });

  it('uses addEventListener instead of inline event handlers for issue clicks', () => {
    assert.match(html, /addEventListener\(\s*['"]click['"]/, 'issue rows should use addEventListener');
  });
});

// ─── P1: docs.html link rewriting ────────────────────────────────────
describe('docs.html link rewriting', () => {
  const html = readSite('docs.html');

  it('defines rewriteDocLinks function', () => {
    assert.match(html, /function rewriteDocLinks\(/);
  });

  it('calls rewriteDocLinks after rendering markdown', () => {
    assert.match(html, /rewriteDocLinks\(\s*content\s*,\s*path\s*\)/);
  });

  it('preserves URL hash fragments in link rewriting', () => {
    // The function must extract and re-apply hash
    assert.match(html, /parsed\.hash/, 'rewriteDocLinks must preserve URL hash for anchor scrolling');
  });

  it('preserves URL search params in link rewriting', () => {
    assert.match(html, /parsed\.search/, 'rewriteDocLinks must preserve URL search params');
  });

  it('scrolls to anchor after loading in-viewer doc with hash', () => {
    assert.match(html, /scrollIntoView/, 'in-viewer loads with hash should scroll to the anchor');
  });

  it('sanitizes markdown through DOMPurify', () => {
    assert.match(html, /DOMPurify\.sanitize\(\s*marked\.parse\(/);
  });
});

// ─── P2: No runtime Tailwind CDN ─────────────────────────────────────
describe('no runtime Tailwind CDN', () => {
  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} does not load cdn.tailwindcss.com`, () => {
      const html = readSite(page);
      assert.doesNotMatch(html, /cdn\.tailwindcss\.com/, `${page} should use pre-built tailwind.css, not CDN`);
    });
  }

  it('pre-built tailwind.css exists', () => {
    assert.ok(existsSync(resolve(SITE, 'tailwind.css')), 'site/tailwind.css must exist as a committed asset');
  });
});

// ─── P2: lang toggle scoping ─────────────────────────────────────────
describe('lang toggle only on translated pages', () => {
  it('main.js skips initLang when lang-toggle button is absent', () => {
    const js = readSite('main.js');
    // initLang must bail early if no button — prevents setting <html lang>
    // on pages without translations
    assert.match(js, /if\s*\(\s*!btn\s*\)\s*return/, 'initLang should return early when lang-toggle button is missing');
  });

  for (const page of ['docs.html', 'community.html']) {
    it(`${page} does not have a lang-toggle button`, () => {
      const html = readSite(page);
      assert.doesNotMatch(
        html,
        /id\s*=\s*["']lang-toggle["']/,
        `${page} should not have lang-toggle (no translations)`,
      );
    });
  }
});

// ─── Local asset existence ───────────────────────────────────────────
describe('HTML-referenced local assets exist', () => {
  const assetRe = /(?:src|href)\s*=\s*["']((?:assets|styles|main|tailwind)[^"']*?)["']/g;

  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} — all local asset paths resolve`, () => {
      const html = readSite(page);
      const missing = [];
      let m;
      while ((m = assetRe.exec(html)) !== null) {
        const ref = m[1];
        // Skip absolute URLs and data URIs
        if (/^(https?:|data:)/i.test(ref)) continue;
        if (!existsSync(resolve(SITE, ref))) missing.push(ref);
      }
      assert.deepStrictEqual(missing, [], `Missing assets in ${page}: ${missing.join(', ')}`);
    });
  }
});

// ─── SETUP.md compatibility ──────────────────────────────────────────
describe('SETUP.md compatibility', () => {
  const ROOT = resolve(SITE, '..');

  it('SETUP.md exists (not prematurely deleted)', () => {
    assert.ok(existsSync(resolve(ROOT, 'SETUP.md')), 'SETUP.md must exist until full content migration is complete');
  });

  it('SETUP.zh-CN.md exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'SETUP.zh-CN.md')), 'SETUP.zh-CN.md must exist alongside SETUP.md');
  });
});

// ─── CDN version pinning ─────────────────────────────────────────────
describe('CDN scripts are version-pinned', () => {
  for (const page of ['docs.html', 'community.html']) {
    it(`${page} — marked is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('marked')) {
        assert.match(html, /marked@[\d.]+/, 'marked CDN must specify an exact version');
      }
    });

    it(`${page} — DOMPurify is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('dompurify')) {
        assert.match(html, /dompurify@[\d.]+/, 'DOMPurify CDN must specify an exact version');
      }
    });
  }
});
