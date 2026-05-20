import { chromium } from '/Users/lang/repo/npm/_npx/b234c773f454f454/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';
import { join } from 'path';

const OUT = join(import.meta.dirname, 'detail-compare');
mkdirSync(OUT, { recursive: true });

const PORTS = [3001, 3003];

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'skills', path: '/settings?s=skills' },
  { name: 'members', path: '/settings?s=members' },
  { name: 'accounts', path: '/settings?s=accounts' },
  { name: 'mcp', path: '/settings?s=mcp' },
  { name: 'voice', path: '/settings?s=voice' },
  { name: 'system', path: '/settings?s=system' },
  { name: 'notify', path: '/settings?s=notify' },
  { name: 'im', path: '/settings?s=im' },
  { name: 'marketplace', path: '/settings?s=marketplace' },
  { name: 'rules', path: '/settings?s=rules' },
  { name: 'ops', path: '/settings?s=ops' },
  { name: 'memory', path: '/memory' },
  { name: 'memory-health', path: '/memory?tab=health' },
  { name: 'memory-graph', path: '/memory?tab=graph' },
  { name: 'signals', path: '/signals' },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  for (const port of PORTS) {
    const page = await context.newPage();
    for (const { name, path } of PAGES) {
      const url = `http://localhost:${port}${path}`;
      const file = join(OUT, `${port}-${name}.png`);
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`OK ${port}-${name}`);
      } catch (e) {
        console.log(`FAIL ${port}-${name}: ${e.message.slice(0, 120)}`);
        try { await page.screenshot({ path: file, fullPage: true }); } catch {}
      }
    }
    await page.close();
  }

  await browser.close();
  console.log('Done');
}

run().catch(e => { console.error(e); process.exit(1); });
