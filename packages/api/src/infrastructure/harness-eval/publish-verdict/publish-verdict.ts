import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CapabilityWakeupSourceSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { validateCapabilityWakeupSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import { mapPublishVerdictError } from './error-mapping.js';
import { computePublishPolicy } from './publish-policy.js';
import type {
  ArtifactPublisher,
  HandlerError,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  VerdictGenerator,
} from './types.js';
import {
  assertNoNewlineInBulletFields,
  inferSourceRefsKind,
  isA2aSourceRefs,
  isAnchorTelemetrySourceRefs,
  isFrictionSourceRefs,
  isKnownSourceRefsKind,
  isMemorySourceRefs,
  isPromptSegmentsSourceRefs,
  isQcMetricsSourceRefs,
  isSopSourceRefs,
  isTaskOutcomeSourceRefs,
  validateAnchorTelemetrySelector,
  validateFrictionRollupSelector,
  validateMemoryRecallSelector,
  validatePromptSegmentsSelector,
  validateQcMetricsSelector,
  validateSopTraceSelector,
  validateSourceRefsFormat,
  validateTaskOutcomeSourceRefs,
} from './validation.js';

export type {
  ArtifactPublisher,
  ArtifactRef,
  HandlerError,
  PublishArtifactOpts,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  ResolvedSourceRefs,
  VerdictGenerator,
  VerdictSourceRefs,
} from './types.js';

// AC-H8: length + slug + idempotency (复用 generate-now 模式)
const MAX_VERDICT_ID_LEN = 128;
const MAX_PHENOMENON_LEN = 2048;
const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * F192 Phase H / F257 sunset — Verdict Publishing Pipeline.
 * Eval cat calls cat_cafe_publish_verdict MCP → handler validates → generator
 * writes to a temporary output root → ArtifactPublisher atomically commits the
 * artifact to a durable store. Runtime artifacts do NOT live in the product Git
 * repository.
 */

const defaultArtifactPublisher: ArtifactPublisher = {
  async publishArtifact() {
    throw new Error('ArtifactPublisher not injected (must wire real impl at route layer)');
  },
};

/**
 * AC-H1: Validate VerdictHandoffPacket schema (server NEVER 造 evidence).
 * AC-H7 partial: input.domain must match packet.domainId.
 * AC-H2: call generator → atomically publish outside product Git → return artifact ID + URL.
 *
 * F192 Phase H 收尾 PR-2 (砚砚 R1 P1): handler is now domain-agnostic.
 *   - Replaced hardcoded `packet.domainId !== 'eval:a2a'` check with
 *     `if (!deps.generator) → 501` (route-layer dispatches single generator per domain
 *     via `eval-hub.ts opts.verdictGenerators[domainId]`)
 *   - Removed a2a-specific source resolution from stage callback (a2a adapter
 *     handles its own resolve+copy; cw adapter calls provider.resolve internally)
 */
export async function handlePublishVerdict(
  deps: PublishVerdictDeps,
  input: PublishVerdictInput,
): Promise<PublishVerdictSuccess | HandlerError> {
  // AC-H1: validate full packet schema
  let packet: VerdictHandoffPacket;
  try {
    packet = parseVerdictHandoffPacket(input.packet);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, error: 'invalid_packet', detail: message };
  }

  // AC-H7 partial: cross-check input.domain ↔ packet.domainId (consistency guard)
  if (input.domain !== packet.domainId) {
    return {
      status: 400,
      error: 'domain_mismatch',
      detail: `input.domain '${input.domain}' does not match packet.domainId '${packet.domainId}'`,
    };
  }

  // 砚砚 R11 P1 + AC-H1: completeness — schema validates "array", guard checks
  // "non-empty". Cat owns metric/trace refs (NOT bundle-overridden); reject early
  // before invoking generator if cat omitted them. snapshot/attribution placeholders
  // also checked here (will be overridden by bundle but cat must still send shape).
  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    return { status: 400, error: 'handoff_incomplete', detail: `handoff_incomplete: ${handoffDecision.reason}` };
  }

  // 砚砚 R18 P2 + cloud R18 P2: reject \r\n in fields renderer writes as single-line
  // bullets (read-model regex parses first line — newline truncates + enables injection).
  const newlineError = assertNoNewlineInBulletFields(packet);
  if (newlineError) return newlineError;

  // AC-H3 + 砚砚 R6 P1: catId from callback auth (MCP layer). Domain allowlist
  // respects OQ-20 Redis override (symmetric with trigger-now), else static registry.
  if (!input.catId) {
    return {
      status: 401,
      error: 'unauthenticated',
      detail: 'catId not provided — MCP layer must derive from callback',
    };
  }
  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domainEntry = domains.get(packet.domainId as Parameters<typeof domains.get>[0]);
  if (!domainEntry) {
    return {
      status: 400,
      error: 'domain_not_registered',
      detail: `Domain '${packet.domainId}' not found in eval-domains/ registry`,
    };
  }
  // 砚砚 R6 P1: prefer Redis override if set, fallback to static registry cat
  let allowedCatId = domainEntry.evalCat.catId as string;
  let overrideApplied = false;
  if (deps.redis) {
    try {
      const override = await getEvalCatOverride(deps.redis, packet.domainId);
      if (override) {
        allowedCatId = override.catId;
        overrideApplied = true;
      }
    } catch {
      // Redis read failure: fall back to static cat (safer than open-fail)
    }
  }
  if (input.catId !== allowedCatId) {
    return {
      status: 403,
      error: 'not_allowed',
      detail: `catId '${input.catId}' is not the eval cat for domain '${packet.domainId}' (expected '${allowedCatId}'${overrideApplied ? ' via OQ-20 Redis override' : ' from registry'})`,
    };
  }

  // AC-H8: length + slug + idempotency (复用 generate-now 模式)
  if (packet.id.length > MAX_VERDICT_ID_LEN) {
    return {
      status: 400,
      error: 'invalid_packet_id',
      detail: `packet.id must be <= ${MAX_VERDICT_ID_LEN} chars (got ${packet.id.length})`,
    };
  }
  if (!SAFE_VERDICT_ID.test(packet.id)) {
    return {
      status: 400,
      error: 'invalid_packet_id',
      detail: `packet.id must match safe slug pattern /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric + hyphens, no leading hyphen). Got: '${packet.id}'`,
    };
  }
  if (packet.phenomenon.length > MAX_PHENOMENON_LEN) {
    return {
      status: 400,
      error: 'invalid_packet',
      detail: `packet.phenomenon must be <= ${MAX_PHENOMENON_LEN} chars (got ${packet.phenomenon.length})`,
    };
  }
  // Idempotency is enforced by ArtifactPublisher.publishArtifact (atomic check +
  // rename). No live-tree fast-fail is needed in the artifact-store era.

  // PR-2 (砚砚 R1 P1): handler pre-validates sourceRefs shape per kind for proper
  // 4xx error codes. Adapter-level validation is defense-in-depth (catches when
  // generator called outside handler flow), but user-facing validation lives here.
  //
  // cloud R8 P2 (PR-2): cross-check sourceRefs.kind ↔ packet.domainId BEFORE
  // per-kind validation. Wrong-shape input for a supported domain (e.g. a2a refs
  // sent for capability-wakeup domain, or cw selector sent for a2a domain) is
  // user-correctable; rejecting at 400 here is better UX than letting it
  // dispatch to adapter → throw `*_adapter_wrong_kind` → 500 generator_failed.
  const refsKind = inferSourceRefsKind(input.sourceRefs);
  const expectedKind = domainEntry.sourceRefsKind;
  if (expectedKind && expectedKind !== refsKind) {
    return {
      status: 400,
      error: 'sourceRefs_kind_mismatch',
      detail: `Domain '${packet.domainId}' expects sourceRefs.kind='${expectedKind}', got '${refsKind}'. Registry sourceRefsKind is the contract; explicit validator/generator wiring must still exist for the domain to publish.`,
    };
  }
  if (!isKnownSourceRefsKind(refsKind)) {
    return {
      status: 501,
      error: 'unsupported_source_refs_kind',
      detail: `Domain '${packet.domainId}' declares sourceRefs.kind='${refsKind}', but publish-verdict has no validator wiring for that selector kind yet. Add explicit validator/generator wiring before using this kind.`,
    };
  }

  if (isSopSourceRefs(input.sourceRefs)) {
    const selectorError = validateSopTraceSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isMemorySourceRefs(input.sourceRefs)) {
    const selectorError = validateMemoryRecallSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isFrictionSourceRefs(input.sourceRefs)) {
    // ⚠️ friction branch MUST precede the a2a branch: isA2aSourceRefs returns true
    // for undefined/missing-kind refs (backward-compat default).
    const selectorError = validateFrictionRollupSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isAnchorTelemetrySourceRefs(input.sourceRefs)) {
    // F236 Track-2: anchor-telemetry-snapshot selector (砚砚 R1 P1-1).
    const selectorError = validateAnchorTelemetrySelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isQcMetricsSourceRefs(input.sourceRefs)) {
    // F253 Phase C: qc-metrics-rollup selector.
    const selectorError = validateQcMetricsSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isPromptSegmentsSourceRefs(input.sourceRefs)) {
    // F257 Phase A Line B: prompt-segments selector (harness-ledger, fail-closed).
    const selectorError = validatePromptSegmentsSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isA2aSourceRefs(input.sourceRefs)) {
    const refsCheck = validateSourceRefsFormat(input.sourceRefs);
    if (!refsCheck.ok) return refsCheck.error;
  } else if (isTaskOutcomeSourceRefs(input.sourceRefs)) {
    const refsCheck = validateTaskOutcomeSourceRefs(input.sourceRefs);
    if (!refsCheck.ok) return refsCheck.error;
  } else {
    const cwSelector = input.sourceRefs as unknown as CapabilityWakeupSourceSelector;
    // PR-1a structural validator (capability non-empty / no newlines / window edges finite + ordered).
    const selectorError = validateCapabilityWakeupSelector(cwSelector);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
    // trial-ids selector remains unsupported until a durable trial store ships.
    // Window selectors may omit sessionIds: provider resolves an unbiased runtime-session
    // window scan when production wires SessionWindowEnumerator.
    if (cwSelector.kind !== 'capability-wakeup-trial-window') {
      return {
        status: 400,
        error: 'invalid_source_ref',
        detail: `PR-2 wired only 'capability-wakeup-trial-window' kind for capability-wakeup domain (got '${cwSelector.kind}'; trial-ids selector reserved for future durable trial store PR)`,
      };
    }
  }

  // PR-2 (砚砚 R1 P1): route layer dispatches per-domain generator from
  // `opts.verdictGenerators?.[domainId]` → if undefined, no generator wired → 501.
  // (Old hardcoded `domainId !== 'eval:a2a'` check removed; route layer is now SoT.)
  if (!deps.generator) {
    return {
      status: 501,
      error: 'unsupported_generator',
      detail: `Domain '${packet.domainId}' has no live-verdict generator wired. Wire via opts.verdictGenerators in eval-hub.ts route registration.`,
    };
  }

  // F257 / F192 sunset: delegate durable publication to ArtifactPublisher.
  // Generator writes into a temporary output root; the publisher atomically
  // commits the artifact to a durable store outside the product Git repository.
  const artifactPublisher = deps.artifactPublisher ?? defaultArtifactPublisher;
  const generator: VerdictGenerator = deps.generator; // checked above (501 if missing)

  let generated: {
    verdictPath: string;
    bundleDir: string;
    extraStagedPaths?: string[];
    afterPublish?: () => void | Promise<void>;
  } | null = null;
  try {
    const ref = await artifactPublisher.publishArtifact({
      packet,
      sourceRefs: input.sourceRefs,
      async generate(outputRoot) {
        generated = await generator(packet, input.sourceRefs, {
          harnessFeedbackRoot: outputRoot,
          liveHarnessFeedbackRoot: deps.harnessFeedbackRoot,
          ownerUserId: input.ownerUserId,
          taskOutcomeDbPath: deps.taskOutcomeDbPath,
          eventMemoryDbPath: deps.eventMemoryDbPath,
        });
        return generated;
      },
    });

    if (!generated) {
      return { status: 500, error: 'internal', detail: 'generate callback did not produce artifact' };
    }

    // PR-3 (砚砚 R2): read attribution.json from the durable bundle to compute publish
    // policy. In the old Git-publisher era this drove PR labels/body; in the artifact
    // era it is retained for metadata/logging and future policy-driven side effects.
    let attribution: unknown;
    try {
      const attrPath = resolve(ref.bundleDir, 'attribution.json');
      if (existsSync(attrPath)) {
        attribution = JSON.parse(readFileSync(attrPath, 'utf8'));
      }
    } catch {
      // Fail-open: undefined → computePublishPolicy returns regular_pr
    }
    computePublishPolicy(packet, attribution); // retained for audit/metadata

    return {
      ok: true,
      verdictPath: ref.verdictPath,
      bundleDir: ref.bundleDir,
      artifactId: ref.artifactId,
      artifactUrl: ref.artifactUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const mapped = mapPublishVerdictError(message);
    if (mapped) return mapped;
    if (!generated) return { status: 500, error: 'generator_failed', detail: message };
    return { status: 500, error: 'publisher_failed', detail: message };
  }
}
