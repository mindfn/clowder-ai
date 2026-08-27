/**
 * Pure-function URL resolution for the docs viewer.
 * Extracted from docs.html so link-rewriting logic is testable
 * without a browser DOM.
 *
 * The docs.html inline script calls resolveDocLink() and applies
 * the result to DOM elements; this module owns only the URL math.
 */

const REPO = 'zts212653/clowder-ai';
const BRANCH = 'main';
const GH_BLOB = `https://github.com/${REPO}/blob/${BRANCH}/`;
const GH_RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

/**
 * Resolve a relative href found inside a rendered markdown document.
 *
 * @param {string} href      — the raw href attribute value
 * @param {string} docPath   — repo-relative path of the document being viewed
 * @param {Set<string>} loadable — set of repo-relative .md paths the viewer can load
 * @returns {{ type: 'skip' } |
 *           { type: 'viewer', path: string, hash: string } |
 *           { type: 'github', url: string }}
 */
export function resolveDocLink(href, docPath, loadable) {
  if (!href || /^(https?:|mailto:|#|javascript:)/i.test(href)) {
    return { type: 'skip' };
  }
  const parsed = new URL(href, 'file:///' + docPath);
  const resolved = parsed.pathname.replace(/^\//, '');
  const hash = parsed.hash || '';
  const search = parsed.search || '';

  if (resolved.endsWith('.md') && loadable.has(resolved)) {
    return { type: 'viewer', path: resolved, hash };
  }
  return { type: 'github', url: GH_BLOB + resolved + search + hash };
}

/**
 * Resolve a relative image src to a GitHub raw URL.
 *
 * @param {string} src     — the raw src attribute value
 * @param {string} docPath — repo-relative path of the document being viewed
 * @returns {string|null}  — resolved raw URL, or null if absolute/data
 */
export function resolveImageSrc(src, docPath) {
  if (!src || /^(https?:|data:)/i.test(src)) return null;
  const resolved = new URL(src, 'file:///' + docPath).pathname.replace(/^\//, '');
  return GH_RAW + resolved;
}
