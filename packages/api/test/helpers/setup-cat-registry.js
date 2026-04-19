/**
 * Auto-populate catRegistry for tests.
 *
 * Loads breeds from cat-template.json directly (no catalog overlay) so the
 * registry is deterministic regardless of stale .cat-cafe/cat-catalog.json
 * files that other tests may create during their run.
 *
 * Usage: import './helpers/setup-cat-registry.js';
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../../../cat-template.json');

async function registerAllCats() {
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  // Pass explicit path → reads ONLY cat-template.json, skips catalog overlay.
  // This avoids "Duplicate catId" errors from stale catalog files created by
  // other tests (e.g. cat-account-binding bootstraps .cat-cafe/cat-catalog.json
  // at the repo root, and its structure may conflict with the template).
  const allConfigs = toAllCatConfigs(loadCatConfig(TEMPLATE_PATH));
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
}

await registerAllCats();
