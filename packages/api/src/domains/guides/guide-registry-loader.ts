/**
 * F150: Load guide registry from YAML source.
 *
 * Provides a validated set of known guide IDs for server-side validation,
 * and the full registry entries for the resolve MCP tool.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

export interface GuideRegistryEntry {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  category: string;
  priority: string;
  cross_system: boolean;
  estimated_time: string;
  flow_file: string;
}

interface RegistryFile {
  guides: GuideRegistryEntry[];
}

/** Resolve project root (3 levels up from this file's dist location) */
function findProjectRoot(): string {
  // At runtime: packages/api/dist/domains/guides/guide-registry-loader.js
  // Project root is 5 dirs up from dist file
  return resolve(__dirname, '..', '..', '..', '..', '..');
}

let cachedEntries: GuideRegistryEntry[] | null = null;
let cachedIds: Set<string> | null = null;

function ensureLoaded(): void {
  if (cachedEntries) return;
  const root = findProjectRoot();
  const registryPath = resolve(root, 'guides', 'registry.yaml');
  const raw = readFileSync(registryPath, 'utf-8');
  const parsed = YAML.parse(raw) as RegistryFile;
  if (!parsed?.guides || !Array.isArray(parsed.guides)) {
    throw new Error('[F150] Invalid guide registry: missing "guides" array');
  }
  cachedEntries = parsed.guides;
  cachedIds = new Set(parsed.guides.map((g) => g.id));
}

/** Get set of valid guide IDs */
export function getValidGuideIds(): Set<string> {
  ensureLoaded();
  return cachedIds!;
}

/** Get all registry entries (for resolve tool) */
export function getRegistryEntries(): GuideRegistryEntry[] {
  ensureLoaded();
  return cachedEntries!;
}

/** Check if a guideId is valid */
export function isValidGuideId(guideId: string): boolean {
  return getValidGuideIds().has(guideId);
}
