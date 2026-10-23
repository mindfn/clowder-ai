/**
 * Evidence-source prerequisite gate for scheduled eval domains.
 *
 * Verdict provenance: eval:a2a build verdict
 * `2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build` (PR #19).
 *
 * Direction B's `publishPrereqProbe` (eval-domain-daily.ts) answers "can this
 * runtime ACCEPT a published verdict?". This gate answers the upstream
 * question: "can the domain's evidence source PRODUCE evidence at all?"
 *
 * eval:a2a consumes `f167-runtime-eval` artifacts derived from live OTel
 * telemetry. When `TELEMETRY_HMAC_SALT` is unset in a non-dev environment,
 * `initTelemetry()` disables OTel at boot — no fresh snapshots can exist, and
 * invoking the eval cat burns a full LLM session to re-conclude "telemetry
 * still disabled" (the 2026-06-30 → 2026-07-07 series produced daily
 * near-identical verdicts). Failing closed BEFORE invocation posts a
 * zero-LLM-cost skip notice to the domain's own system thread instead,
 * keeping the gap visible without the burn.
 *
 * OTel init state is fixed for the process lifetime (the salt is read at
 * boot), so a boolean thunk wired from bootstrap is a complete input — no
 * re-probing or caching needed.
 */

import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';

/** Minimal domain projection the gate needs — keeps probes trivial to test. */
export type EvidenceGateDomain = Pick<EvalDomainRegistryEntry, 'domainId' | 'sourceAdapter'>;

export type EvidencePrereqResult = { ok: true } | { ok: false; reason: string };

export type EvidencePrereqProbe = (domain: EvidenceGateDomain) => EvidencePrereqResult | Promise<EvidencePrereqResult>;

/**
 * Source adapters whose evidence pipeline hard-requires live OTel telemetry.
 * Registry `sourceAdapter` is a free slug (see eval-domain-registry.ts), so
 * the adapter → prerequisite mapping lives here, next to the probe.
 */
const TELEMETRY_BACKED_ADAPTERS: ReadonlySet<string> = new Set(['f167-runtime-eval']);

/**
 * Why there is no "is the evidence source co-located?" check here.
 *
 * Upstream review of zts212653/clowder-ai#1352 raised a real-sounding concern:
 * `otelEnabled` observes the telemetry handle of the process running the CRON,
 * so if evidence came from a DIFFERENT runtime the local handle would prove
 * nothing about it, in both directions.
 *
 * A first fix attempt asserted co-location by parsing `EVAL_BASE_URL`. Review of
 * THIS fork's PR (#185) showed that gate was wired to unrelated configuration:
 * `EVAL_BASE_URL` is read only by the manual CLI `scripts/run-f168-external-case-eval.mjs`
 * and is never consulted on the scheduled path. It also mis-compared ports and
 * could never match `::1` (Node's URL keeps the brackets: `"[::1]"`), so it fell
 * closed on exactly the local topology it was meant to admit.
 *
 * The scheduled path has no remote evidence target to check. `f167-runtime-eval`
 * evidence is a snapshot+attribution PAIR ON DISK under the harness-feedback root
 * (see publish-verdict/a2a-generator-adapter.ts), written by this process's own
 * OTel pipeline. Source resolution is filesystem-relative, not HTTP. The local
 * handle is authoritative because the producer IS this process - structurally,
 * not accidentally.
 *
 * If a telemetry-backed adapter ever fetches evidence over the network, the
 * decision belongs at THIS boundary: add it to the set above only together with
 * a probe that can observe that source. Do not re-derive co-location from env.
 */

export function isTelemetryBackedAdapter(sourceAdapter: string): boolean {
  return TELEMETRY_BACKED_ADAPTERS.has(sourceAdapter);
}

/**
 * Probe factory. Bootstrap wires `otelEnabled: () => !!telemetryHandle.getMetricsText`
 * — the same init-state signal `GET /api/telemetry/health` reports as
 * `otelEnabled` (routes/telemetry.ts Phase K note: actual init state, not an
 * env-var proxy). Non-telemetry-backed adapters always pass through.
 */
export function createTelemetryEvidencePrereqProbe(opts: {
  otelEnabled: () => boolean;
  /** Override the reason text; defaults to the health route's disabledReason derivation. */
  disabledReason?: () => string;
}): EvidencePrereqProbe {
  return (domain) => {
    if (!isTelemetryBackedAdapter(domain.sourceAdapter)) return { ok: true };
    if (opts.otelEnabled()) return { ok: true };
    const reason =
      opts.disabledReason?.() ??
      (process.env.OTEL_SDK_DISABLED === 'true'
        ? 'OTel disabled by OTEL_SDK_DISABLED=true'
        : 'OTel disabled at boot: HMAC salt validation failed (TELEMETRY_HMAC_SALT not configured)');
    return { ok: false, reason };
  };
}

/** Fail-closed evaluation: a probe that throws is treated as "evidence unavailable". */
export async function evaluateEvidencePrereq(
  probe: EvidencePrereqProbe,
  domain: EvidenceGateDomain,
): Promise<EvidencePrereqResult> {
  try {
    return await Promise.resolve(probe(domain));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `evidence prereq probe threw: ${message}` };
  }
}

/**
 * Derive the actionable next step from the DETECTED cause.
 *
 * Upstream review finding (zts212653/clowder-ai#1352, comment by 砚砚): the
 * notice previously recommended configuring `TELEMETRY_HMAC_SALT` even when
 * the detected cause was an intentional `OTEL_SDK_DISABLED=true`. Telling an
 * operator to set a salt they already set — for a toggle they deliberately
 * flipped — sends them down the wrong path. Match the advice to the cause.
 */
function buildNextActionLines(reason: string): string[] {
  if (reason.includes('OTEL_SDK_DISABLED')) {
    return [
      'Next action: OTel is intentionally disabled via `OTEL_SDK_DISABLED=true`.',
      'Unset it (or set it to `false`) and restart the API runtime to resume',
      "evidence collection, or set `enabled: false` in this domain's registry",
      'YAML to pause the schedule intentionally.',
    ];
  }
  if (reason.includes('TELEMETRY_HMAC_SALT') || /HMAC salt/i.test(reason)) {
    return [
      'Next action: configure a non-empty `TELEMETRY_HMAC_SALT` for the API',
      'runtime and restart it (OTel initializes at boot), or set `enabled: false`',
      "in this domain's registry YAML to pause the schedule intentionally.",
    ];
  }
  return [
    'Next action: resolve the blocker quoted above on the API runtime and',
    "restart it, or set `enabled: false` in this domain's registry YAML to",
    'pause the schedule intentionally.',
  ];
}

/**
 * Stable-header skip notice posted to the domain's OWN system thread when the
 * cron fails closed. Header format mirrors `buildPublishPrereqSkippedMessage`
 * so eval-domain readers / log scrubbers can grep both skip classes uniformly.
 */
export function buildEvidencePrereqSkippedMessage(domain: EvidenceGateDomain, reason: string): string {
  return [
    `## Eval Domain: ${domain.domainId} — SKIPPED (evidence source unavailable)`,
    '',
    "The scheduled eval was skipped because this domain's evidence source",
    `(\`${domain.sourceAdapter}\`) cannot produce evidence on this runtime:`,
    '',
    `> ${reason}`,
    '',
    'Why this matters: invoking the eval cat without a live evidence source',
    'burns a full LLM session to re-conclude the same gap on every fire. The',
    'fail-closed skip keeps the gap visible in this thread at zero LLM cost.',
    '',
    ...buildNextActionLines(reason),
  ].join('\n');
}
