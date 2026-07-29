import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from '../domain/eval-domain-registry.js';
import { type EvalHubFrictionProjection, loadEvalHubFrictionProjection } from './eval-hub-friction-projection.js';
import {
  computeNextCronFire,
  computeStale,
  extractBullet,
  extractEvidenceRefs,
  markSupersededAsClosed,
  type ParsedVerdictMarkdown,
  parseHarness,
  parseVerdictMarkdown,
  repoRelative,
  requiredString,
  requiredText,
  requiredVerdict,
} from './eval-hub-read-model-helpers.js';

type CountRecord = Record<string, number | null>;

export interface LoadEvalHubSummaryInput {
  harnessFeedbackRoot: string;
  /**
   * F257 / F192 sunset: optional durable artifact store root where
   * ArtifactPublisher commits verdict bundles (outside the product Git repo).
   * When provided, live verdicts are loaded from both the legacy in-repo
   * `verdicts/` directory AND the artifact store; artifact-store entries take
   * precedence for the same verdict id.
   */
  artifactStoreRoot?: string;
  /**
   * Wall-clock reference for staleness checks. Defaults to `new Date()`.
   * Injectable so date-dependent regression tests don't drift over time.
   * F192 P2: enables `lifecycle.stale` lifecycle calculation (previously hardcoded false).
   */
  now?: Date;
}

export interface EvalDomainSummary {
  domainId: string;
  displayName: string;
  systemThreadId: string;
  frequency: string;
  evalCatId: string;
  evalCatHandle: string;
  /**
   * Sunset state. `false` means the domain's yaml has `enabled: false` —
   * scheduled cron silently skips it, and `nextCronFireAt` is omitted (because
   * cron does NOT fire for sunset domains; showing a future fire time would be
   * the operator-facing mirror of the silent-fire bug the sunset is meant to
   * fix). Frontend renders a "Sunset" indicator instead of "下次评估".
   * `true` (default) means the domain is active and the cron will fire as
   * scheduled.
   */
  enabled: boolean;
  hasVerdict: boolean;
  latestVerdictId?: string;
  latestVerdict?: EvalHubItem['verdict'];
  /**
   * Next scheduled cron fire time (computed from frequency, not verdict
   * re-eval deadline). Omitted when `enabled === false` — sunset domains
   * have no upcoming fire, and surfacing a future date would lie to operators.
   */
  nextCronFireAt?: string;
}

export interface EvalHubSummary {
  generatedAt: string;
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
    registeredDomains: number;
  };
  domains: EvalDomainSummary[];
  items: EvalHubItem[];
}

export interface EvalHubItem {
  id: string;
  domainId: EvalDomainRegistryEntry['domainId'];
  packetId: string;
  feedbackType: 'live-verdict';
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
  ownerAsk: string;
  harnessUnderEval: {
    featureId: string;
    componentId: string;
    name: string;
  };
  reeval: {
    nextEvalAt?: string;
    status: 'observing' | 'pending_owner' | 'pending_reeval';
    summary: string;
  };
  lifecycle: {
    ownerResponseStatus: 'not_required' | 'not_started';
    closureStatus: 'observing' | 'open';
    stale: boolean;
  };
  evidence: {
    snapshotRefs: string[];
    attributionRefs: string[];
    metricRefs: string[];
    otherRefs: string[];
  };
  trend: {
    generatedAt: string;
    window: {
      startMs?: number;
      endMs?: number;
      durationHours: number;
    };
    components: Array<{
      componentId: string;
      componentName: string;
      confidence: string;
      activationCounts: CountRecord;
      frictionCounts: CountRecord;
    }>;
  };
  systemWorkspace: {
    kind: 'eval_domain';
    id: EvalDomainRegistryEntry['domainId'];
    label: string;
    threadId: string;
    stateSot: 'registry';
  };
  source: {
    verdictPath: string;
    bundleDir: string;
  };
  friction?: EvalHubFrictionProjection;
}

type VerdictEntry = {
  verdict: ParsedVerdictMarkdown;
  bundleDir: string;
  verdictPath: string;
};

export function loadEvalHubSummary(input: LoadEvalHubSummaryInput): EvalHubSummary {
  const verdictsDir = join(input.harnessFeedbackRoot, 'verdicts');
  const domains = loadDomains(input.harnessFeedbackRoot);
  const now = input.now ?? new Date();
  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));

  let entries: VerdictEntry[] = existsSync(verdictsDir)
    ? readdirSync(verdictsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => {
          const verdictPath = join(verdictsDir, entry.name);
          const verdict = parseVerdictMarkdown(verdictPath);
          return {
            verdict,
            verdictPath,
            bundleDir: join(input.harnessFeedbackRoot, 'bundles', verdict.id),
          };
        })
    : [];

  // F257 / F192 sunset: durable artifact-store verdicts take precedence over
  // legacy in-repo verdicts for the same id. Load artifacts first, then backfill
  // legacy entries only for ids not present in the artifact store.
  const artifactEntries =
    input.artifactStoreRoot && existsSync(input.artifactStoreRoot)
      ? loadArtifactStoreVerdicts(input.artifactStoreRoot)
      : [];
  const artifactIds = new Set(artifactEntries.map((e) => e.verdict.id));
  entries = [...artifactEntries, ...entries.filter((legacyEntry) => !artifactIds.has(legacyEntry.verdict.id))];

  const items = entries
    .filter((entry) => entry.verdict.frontmatter.feedback_type === 'live-verdict')
    .map((entry) => buildEvalHubItem(input.harnessFeedbackRoot, entry.verdict, entry.bundleDir, domains, now, repoRoot))
    .sort((a, b) => b.trend.generatedAt.localeCompare(a.trend.generatedAt));

  // F192 P2 — supersede gating (PR 791 review).
  // Stale is a *lifecycle state of the active finding per domain*, not a property
  // every historical verdict carries. After sorting by trend.generatedAt desc, the
  // first item per domain is the active verdict; the rest have been closed by
  // re-eval (a newer live verdict landed) and must not count as stale even when
  // their own nextEvalAt has elapsed — otherwise counts.stale would accumulate
  // historical overdue verdicts forever and never return to zero, defeating the
  // re-eval closure loop the Hub exists to surface (AC-E7 / AC-E9).
  markSupersededAsClosed(items);

  // F192 livefix OQ-16: Build domain summaries for ALL registered domains,
  // including those without verdicts (e.g. eval:memory before first eval run).
  const domainSummaries: EvalDomainSummary[] = [...domains.values()].map((domain) => {
    const domainVerdicts = items.filter((item) => item.domainId === domain.domainId);
    const latest = domainVerdicts[0]; // items already sorted by date desc
    // Sunset 2026-06-06 (F192 silent-fire fix): when domain.enabled === false the
    // scheduled cron silently skips it, so we must NOT publish a future
    // nextCronFireAt — that would mirror silent-fire on the operator-facing surface
    // (Hub UI would say "next fire Sunday" while cron actually never fires).
    const isEnabled = domain.enabled !== false;
    return {
      domainId: domain.domainId,
      displayName: domain.displayName,
      systemThreadId: domain.systemThreadId,
      frequency: domain.frequency,
      evalCatId: domain.evalCat.catId,
      evalCatHandle: domain.evalCat.handle,
      enabled: isEnabled,
      hasVerdict: domainVerdicts.length > 0,
      ...(isEnabled ? { nextCronFireAt: computeNextCronFire(domain.frequency, now).toISOString() } : {}),
      ...(latest
        ? {
            latestVerdictId: latest.id,
            latestVerdict: latest.verdict,
          }
        : {}),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      actionable: items.filter((item) => item.verdict !== 'keep_observe').length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
      registeredDomains: domainSummaries.length,
    },
    domains: domainSummaries,
    items,
  };
}

/**
 * F257 / F192 sunset: scan durable artifact store for verdicts committed by
 * ArtifactPublisher. Each artifact lives at `<root>/<domainSlug>/<artifactId>/`.
 *
 * Two internal layouts are supported:
 * - Canonical: `<artifactDir>/verdict.md` + `<artifactDir>/bundle/`
 * - Generator-native: `<artifactDir>/docs/harness-feedback/verdicts/<artifactId>.md`
 *   + `<artifactDir>/docs/harness-feedback/bundles/<artifactId>/`. This matches
 *   the legacy isolated-worktree layout existing generators expect, so the
 *   publisher can commit the worktree verbatim without renames.
 */
function loadArtifactStoreVerdicts(artifactStoreRoot: string): VerdictEntry[] {
  const entries: VerdictEntry[] = [];
  if (!existsSync(artifactStoreRoot)) return entries;

  for (const domainEntry of readdirSync(artifactStoreRoot, { withFileTypes: true })) {
    if (!domainEntry.isDirectory()) continue;
    const domainDir = join(artifactStoreRoot, domainEntry.name);
    for (const artifactEntry of readdirSync(domainDir, { withFileTypes: true })) {
      if (!artifactEntry.isDirectory()) continue;
      const artifactDir = join(domainDir, artifactEntry.name);
      const artifactId = artifactEntry.name;

      // Canonical layout
      let verdictPath = join(artifactDir, 'verdict.md');
      let bundleDir = join(artifactDir, 'bundle');

      // Generator-native isolated-worktree layout
      const nativeVerdictDir = join(artifactDir, 'docs', 'harness-feedback', 'verdicts');
      const nativeVerdictPath = join(nativeVerdictDir, `${artifactId}.md`);
      const nativeBundleDir = join(artifactDir, 'docs', 'harness-feedback', 'bundles', artifactId);
      if (!existsSync(verdictPath) && existsSync(nativeVerdictPath)) {
        verdictPath = nativeVerdictPath;
        bundleDir = existsSync(nativeBundleDir) ? nativeBundleDir : nativeBundleDir;
      }

      if (!existsSync(verdictPath)) continue;
      const verdict = parseVerdictMarkdown(verdictPath);
      // Artifact store filenames are either `verdict.md` or `<artifactId>.md`;
      // the artifact id is the directory name. Override the file-derived id so
      // bundle resolution and Hub item ids match the artifact.
      verdict.id = artifactId;
      entries.push({
        verdict,
        bundleDir,
        verdictPath,
      });
    }
  }
  return entries;
}

function buildEvalHubItem(
  harnessFeedbackRoot: string,
  verdict: ParsedVerdictMarkdown,
  bundleDir: string,
  domains: Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry>,
  now: Date,
  repoRoot: string,
): EvalHubItem {
  const verdictId = verdict.id;
  let resolved: ReturnType<typeof resolveA2aEvidenceBundle>;
  try {
    resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to resolve evidence bundle for ${verdictId}: ${message}`);
  }

  const domainId = requiredString(verdict.frontmatter.domain_id, 'domain_id') as EvalDomainRegistryEntry['domainId'];
  const domain = domains.get(domainId);
  if (!domain) {
    throw new Error(
      `unknown domain_id '${domainId}' in verdict ${verdictId}; registered domains: ${[...domains.keys()].join(', ')}`,
    );
  }

  const evidence = extractEvidenceRefs(verdict.markdown);
  const verdictValue = requiredVerdict(extractBullet(verdict.markdown, 'Verdict'));
  const phenomenon = requiredText(extractBullet(verdict.markdown, 'Phenomenon'), 'phenomenon');
  const ownerAsk = requiredText(extractBullet(verdict.markdown, 'Owner ask'), 'owner ask');
  const harness = parseHarness(extractBullet(verdict.markdown, 'Harness'));
  const reevalSummary = requiredText(extractBullet(verdict.markdown, 'Re-eval'), 're-eval');
  const nextEvalAt = reevalSummary.match(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/)?.[0];
  const friction = loadEvalHubFrictionProjection(domainId, bundleDir, repoRoot);

  return {
    id: verdictId,
    domainId,
    packetId: requiredString(verdict.frontmatter.packet_id, 'packet_id'),
    feedbackType: 'live-verdict',
    verdict: verdictValue,
    phenomenon,
    ownerAsk,
    harnessUnderEval: harness,
    reeval: {
      ...(nextEvalAt ? { nextEvalAt } : {}),
      status: verdictValue === 'keep_observe' ? 'observing' : 'pending_owner',
      summary: reevalSummary,
    },
    lifecycle: {
      ownerResponseStatus: verdictValue === 'keep_observe' ? 'not_required' : 'not_started',
      closureStatus: verdictValue === 'keep_observe' ? 'observing' : 'open',
      // F192 P2: stale = past the verdict's own re-eval deadline (nextEvalAt).
      // SLA reevalWithinHours is already absorbed into nextEvalAt at verdict-creation time,
      // so adding extra grace here would double-discount. A missing nextEvalAt cannot expire.
      stale: computeStale(nextEvalAt, now),
    },
    evidence,
    trend: {
      generatedAt: resolved.snapshot.generatedAt,
      window: resolved.snapshot.window,
      components: resolved.snapshot.components.map((component) => ({
        componentId: component.componentId,
        componentName: component.componentName,
        confidence: component.confidence,
        activationCounts: component.activationCounts,
        frictionCounts: component.frictionCounts,
      })),
    },
    systemWorkspace: {
      kind: 'eval_domain',
      id: domainId,
      label: domain.displayName,
      threadId: domain.systemThreadId,
      stateSot: domain.threadPolicy.stateSot,
    },
    source: {
      verdictPath: repoRelative(repoRoot, verdict.path),
      bundleDir: repoRelative(repoRoot, bundleDir),
    },
    ...(friction ? { friction } : {}),
  };
}

/** Loads all registered eval domains from YAML files. Exported for registry-only validation (e.g. PATCH override). */
export function loadDomains(
  harnessFeedbackRoot: string,
): Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry> {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  if (!existsSync(domainsDir)) return new Map();
  const domains = new Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry>();
  for (const entry of readdirSync(domainsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const parsed = parseYaml(readFileSync(join(domainsDir, entry.name), 'utf8'));
    const domain = parseEvalDomainRegistryFile(parsed);
    domains.set(domain.domainId, domain);
  }
  return domains;
}
