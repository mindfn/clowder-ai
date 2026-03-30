/**
 * F150: Load guide registry from YAML source.
 *
 * Provides a validated set of known guide IDs for server-side validation,
 * and the full registry entries for the resolve MCP tool.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Resolve project root from this file's location */
function findProjectRoot(): string {
  // At runtime: packages/api/dist/domains/guides/guide-registry-loader.js
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '..', '..', '..', '..', '..');
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

export interface GuideMatch {
  id: string;
  name: string;
  description: string;
  estimatedTime: string;
  score: number;
}

/**
 * Match user intent against guide registry keywords.
 * Returns matched guides sorted by score (highest first), or empty array.
 * Used by both the MCP callback endpoint and the pre-invocation routing hook.
 */
export function resolveGuideForIntent(intent: string): GuideMatch[] {
  const entries = getRegistryEntries();
  const query = intent.toLowerCase();
  return entries
    .map((entry) => {
      const score = entry.keywords.filter(
        (kw) => query.includes(kw.toLowerCase()) || kw.toLowerCase().includes(query),
      ).length;
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        estimatedTime: entry.estimated_time,
        score,
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}
