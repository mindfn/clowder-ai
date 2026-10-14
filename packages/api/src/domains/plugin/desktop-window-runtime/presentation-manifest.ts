import { type PluginManifest, validateManifest } from '@clowder-ai/plugin-contract';
import { validateManifest as validatePresentationManifest } from '@clowder-ai/plugin-contract-beta27';
import { desktopWindowContribution } from './admission.js';
import { PUBLISHED_COMPANION_PRESENTATION } from './published-companion-v2.js';

/** Keep the generic manifest ABI unchanged; admit only the delivered companion's
 * new bridge literal. Installation and runtime still authenticate its exact SRI.
 */
export function validateHostPluginManifest(value: unknown): ReturnType<typeof validateManifest> {
  const legacy = validateManifest(value);
  if (legacy.valid) return legacy;
  const published = validatePresentationManifest(value);
  if (
    !published.valid ||
    published.manifest.pluginId !== 'official.companion' ||
    published.manifest.version !== PUBLISHED_COMPANION_PRESENTATION.version
  )
    return legacy;
  // The Host's old structural type differs only at bridgeVersion here. Do not
  // rewrite manifest bytes or infer archive authority from schema compatibility.
  const manifest = published.manifest as PluginManifest;
  const body = desktopWindowContribution(manifest);
  if (!body || String(body.bridgeVersion) !== '1.4.0') return legacy;
  return { valid: true, manifest, errors: [] };
}
