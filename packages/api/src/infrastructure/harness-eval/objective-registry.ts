/**
 * F257 修复清单 #3 — Objective registry loader (definition layer).
 *
 * Reads `docs/harness-feedback/objectives/registry.yaml` — the read-only
 * discovery source for `report_harness_signal`'s `objectiveId`, so cats stop
 * doing archaeology to find valid objectives ("三次上报三次考古"). KD-3:
 * registry 定义层用 YAML；运行时 stats 拆到 Redis/eval.
 *
 * This is the canonical objective DEFINITION layer only: `id + statement`.
 * Unit→objective membership (which segments an objective is evaluated over) is
 * NOT authored here — per the frozen redesign §4.8 it lives in the versioned
 * `UnitEvaluationManifest.objectives` keyed by typed unitRef, and a derived
 * read-model can expose attachments in V2. Keeping a second writable authority
 * out of this file avoids the dual-source drift sol flagged (2a R1 P1-1).
 *
 * Fail-closed (2a R1 P1-2): a load/parse/validation failure is reported as an
 * explicit error, NEVER collapsed to a valid-but-empty catalog — a silent empty
 * would recreate the archaeology gap it exists to close.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface ObjectiveDefinition {
  id: string;
  statement: string;
}

export interface ObjectiveRegistry {
  registryVersion: number;
  objectives: ObjectiveDefinition[];
}

/** Discriminated result: a valid registry, or an explicit failure reason. */
export type ObjectiveRegistryResult = { ok: true; registry: ObjectiveRegistry } | { ok: false; error: string };

/** Canonical objective id shape: `obj-` + kebab-case (lowercase alnum groups). */
const OBJECTIVE_ID_RE = /^obj-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The only registry schema version this loader implements (2a R3 P2-1). */
const SUPPORTED_REGISTRY_VERSION = 1;

function fail(error: string): ObjectiveRegistryResult {
  return { ok: false, error };
}

/** Validate a single objective row → definition, or an error string. */
function validateObjective(entry: unknown, index: number, seen: Set<string>): ObjectiveDefinition | string {
  if (!entry || typeof entry !== 'object') return `objectives[${index}] is not a mapping`;
  // 2a R2 P2-1: fail-closed on unknown keys (registryVersion=1 allows only id/statement).
  // Rejecting rather than stripping keeps the file the single authority — a stray
  // `segments`/typo/未版本化 field can't silently reappear and mislead a human reader.
  for (const key of Object.keys(entry)) {
    if (key !== 'id' && key !== 'statement') {
      const hint =
        key === 'segments'
          ? ' — unit→objective membership belongs to the versioned UnitEvaluationManifest (§4.8), not this definition registry'
          : ' (registryVersion=1 allows only id/statement; bump the schema to add fields)';
      return `objectives[${index}] has unsupported key "${key}"${hint}`;
    }
  }
  const o = entry as { id?: unknown; statement?: unknown };
  if (typeof o.id !== 'string' || o.id.trim() !== o.id || o.id.length === 0) {
    return `objectives[${index}].id must be a trimmed non-empty string`;
  }
  if (!OBJECTIVE_ID_RE.test(o.id)) return `objectives[${index}].id "${o.id}" must match ${OBJECTIVE_ID_RE.source}`;
  if (typeof o.statement !== 'string' || o.statement.trim().length === 0) {
    return `objectives[${o.id}].statement must be a non-empty string`;
  }
  if (seen.has(o.id)) return `duplicate objective id "${o.id}"`;
  seen.add(o.id);
  return { id: o.id, statement: o.statement.trim() };
}

/**
 * Parse + strictly validate the objective registry YAML. Pure (no I/O) so it is
 * unit-testable. Returns an explicit failure (ok:false) on malformed YAML, a
 * non-mapping root, a non-positive-integer version, a missing/non-array
 * `objectives`, any invalid row, or a duplicate id — never a silent empty.
 */
export function parseObjectiveRegistry(rawYaml: string): ObjectiveRegistryResult {
  let doc: unknown;
  try {
    doc = parseYaml(rawYaml);
  } catch (err) {
    return fail(`malformed registry YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== 'object') return fail('registry root must be a mapping');
  // 2a R2 P2-1: fail-closed on unknown root keys (registryVersion=1 allows only
  // registryVersion/objectives). Future fields must bump the schema, not slip through.
  for (const key of Object.keys(doc)) {
    if (key !== 'registryVersion' && key !== 'objectives') {
      return fail(`unknown registry key "${key}" (registryVersion=1 allows only registryVersion/objectives)`);
    }
  }

  const record = doc as { registryVersion?: unknown; objectives?: unknown };
  const version = record.registryVersion;
  // 2a R3 P2-1: this loader implements ONLY v1 semantics, so accept exactly v1. A future
  // schema must ship a versioned parser + bump this — advertising an unimplemented version
  // (2, 999, …) as supported to discovery clients is the inconsistency being closed.
  if (version !== SUPPORTED_REGISTRY_VERSION) {
    return fail(`registryVersion must be exactly ${SUPPORTED_REGISTRY_VERSION} (this loader implements only v1)`);
  }
  if (!Array.isArray(record.objectives)) return fail('registry `objectives` must be an array');

  const objectives: ObjectiveDefinition[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < record.objectives.length; i++) {
    const result = validateObjective(record.objectives[i], i, seen);
    if (typeof result === 'string') return fail(result);
    objectives.push(result);
  }
  return { ok: true, registry: { registryVersion: version, objectives } };
}

/**
 * Load + validate the objective registry from disk. Returns an explicit failure
 * (ok:false) when the file is unreadable — the caller (route/tool) must surface
 * it (503/error), not present it as an empty catalog.
 */
export async function loadObjectiveRegistry(registryPath: string): Promise<ObjectiveRegistryResult> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch (err) {
    return fail(`registry unreadable at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseObjectiveRegistry(raw);
}
