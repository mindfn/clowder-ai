#!/usr/bin/env node
/**
 * F257 #6 slice 6c — 判据② browser capture harness (sol R1 P2-2).
 *
 * Captures the composed 18-vs-0 viewport in a REAL browser (production build).
 *
 * Usage:
 *   pnpm --dir packages/web build && pnpm --dir packages/web start -- -p 3210 &
 *   node packages/web/scripts/capture-f257-eval-window.mjs [port] [outDir]
 *
 * Defaults: port=3210, outDir=<repo>/review-evidence/f257-6c-eval-window
 * Playwright is resolved from the globally installed @playwright/cli package
 * (no new dependency added to the repo).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Resolve playwright without adding a repo dependency: prefer any local install,
// fall back to the globally installed @playwright/cli bundle.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require('/Users/lang/repo/npm/lib/node_modules/@playwright/cli/node_modules/playwright');
  }
}
const { chromium } = loadPlaywright();

/** Pick an actually-installed chromium (global bundle may pin a version not in the cache). */
function resolveChromiumExecutable() {
  const fs = require('node:fs');
  const os = require('node:os');
  const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    const shells = fs
      .readdirSync(cacheRoot)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const dir of shells) {
      const exe = path.join(cacheRoot, dir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to playwright default */
  }
  return undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? '3210';
const outDir = process.argv[3] ?? path.resolve(__dirname, '../../../review-evidence/f257-6c-eval-window');
const url = `http://localhost:${port}/showcase/f257-eval-window`;

const executablePath = resolveChromiumExecutable();
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  // Fail-closed: the composed coordinates must actually be on screen before capturing.
  await page.getByText('tracing(18)', { exact: false }).first().waitFor({ timeout: 15_000 });
  await page.getByText('坐标对照（当前观测 vs 历史评估）').first().waitFor({ timeout: 15_000 });
  await page.getByText('评估窗口未知（历史缓存缺字段）').first().waitFor({ timeout: 15_000 });

  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `f257-6c-composed-${stamp}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`CAPTURED ${file}`);
} finally {
  await browser.close();
}
