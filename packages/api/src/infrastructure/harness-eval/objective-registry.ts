/**
 * F257 修复清单 #3 — Objective registry loader (definition layer).
 *
 * Reads `docs/harness-feedback/objectives/registry.yaml` — the read-only
 * discovery source for `report_harness_signal`'s `objectiveId`, so cats stop
 * doing archaeology to find valid objectives ("三次上报三次考古"). KD-3:
 * registry 定义层用 YAML；运行时 stats 拆到 Redis/eval. This is the DEFINITION
 * layer only (id / statement / segments) — eval_models (metrics/conditions) are
 * the objective-driven redesign V2, layered on top by objectiveId.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface ObjectiveDefinition {
  id: string;
  statement: string;
  /** Segment ids this objective is evaluated over (redesign §2 挂靠段). */
  segments: string[];
}

export interface ObjectiveRegistry {
  registryVersion: number;
  objectives: ObjectiveDefinition[];
}

const EMPTY_REGISTRY: ObjectiveRegistry = { registryVersion: 1, objectives: [] };

/**
 * Parse + shape-validate the objective registry YAML. Pure (no I/O) so it is
 * unit-testable. Malformed entries (missing id/statement) are dropped, never
 * throwing — a bad row must not take down discovery for the good rows.
 */
export function parseObjectiveRegistry(rawYaml: string): ObjectiveRegistry {
  let doc: unknown;
  try {
    doc = parseYaml(rawYaml);
  } catch {
    return EMPTY_REGISTRY;
  }
  if (!doc || typeof doc !== 'object') return EMPTY_REGISTRY;
  const record = doc as { registryVersion?: unknown; objectives?: unknown };
  const registryVersion = typeof record.registryVersion === 'number' ? record.registryVersion : 1;
  const rawObjectives = Array.isArray(record.objectives) ? record.objectives : [];
  const objectives: ObjectiveDefinition[] = [];
  for (const entry of rawObjectives) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as { id?: unknown; statement?: unknown; segments?: unknown };
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    if (typeof o.statement !== 'string' || o.statement.length === 0) continue;
    const segments = Array.isArray(o.segments) ? o.segments.filter((s): s is string => typeof s === 'string') : [];
    objectives.push({ id: o.id, statement: o.statement, segments });
  }
  return { registryVersion, objectives };
}

/** Load the objective registry from disk. Returns the empty registry if unreadable. */
export async function loadObjectiveRegistry(registryPath: string): Promise<ObjectiveRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch {
    return EMPTY_REGISTRY;
  }
  return parseObjectiveRegistry(raw);
}
