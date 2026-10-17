import { type PluginManifest, validateManifest } from '@clowder-ai/plugin-contract';
import { validateManifest as validatePresentationManifest } from '@clowder-ai/plugin-contract-beta27';
import { validateManifest as validateLetterManifest } from '@clowder-ai/plugin-contract-beta28';
import { desktopWindowContribution } from './admission.js';
import { COMPANION_ARCHIVE_CONTRACTS } from './published-companion-v2.js';

/** Keep the generic manifest ABI unchanged; admit only the delivered companion's
 * new bridge literal. Installation and runtime still authenticate its exact SRI.
 */
export function validateHostPluginManifest(value: unknown): ReturnType<typeof validateManifest> {
  const legacy = validateManifest(value);
  if (legacy.valid) return legacy;
  const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined;
  const release = COMPANION_ARCHIVE_CONTRACTS.find(
    (row) => row.version === version && (row.contract === '0.1.0-beta.27' || row.contract === '0.1.0-beta.28'),
  );
  if (!release) return legacy;
  const letter = release.contract === '0.1.0-beta.28';
  const published = letter ? validateLetterManifest(value) : validatePresentationManifest(value);
  if (
    !published.valid ||
    published.manifest.pluginId !== 'official.companion' ||
    published.manifest.version !== release.version
  )
    return legacy;
  // The Host's old structural type differs only at bridgeVersion here. Do not
  // rewrite manifest bytes or infer archive authority from schema compatibility.
  const manifest = published.manifest as PluginManifest;
  const body = desktopWindowContribution(manifest);
  if (!body || String(body.bridgeVersion) !== (letter ? '1.5.0' : '1.4.0')) return legacy;
  return { valid: true, manifest, errors: [] };
}
