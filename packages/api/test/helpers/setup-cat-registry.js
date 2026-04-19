/**
 * Auto-populate catRegistry for tests.
 *
 * Loads the runtime cat config expansion so route tests see the same
 * variant roster as runtime (gpt52/sonnet/spark/etc.).
 *
 * Usage: import './helpers/setup-cat-registry.js';
 */

import { catRegistry } from '@cat-cafe/shared';

async function registerAllCats() {
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  const allConfigs = toAllCatConfigs(loadCatConfig());
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
}

await registerAllCats();
