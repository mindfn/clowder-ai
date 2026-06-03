import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { buildA2aVerdictHandoff } from './eval-a2a-adapter.js';
import { resolveA2aEvidenceBundle } from './eval-a2a-artifact-resolver.js';
import {
  buildA2aNoDataVerdictHandoff,
  type BuildA2aNoDataVerdictInput,
} from './eval-a2a-no-data-adapter.js';

const SANITIZE_RULES_VERSION = 'f192-e-pilot-v1';
const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface GenerateA2aLiveVerdictInput {
  verdictId: string;
  rawSnapshotPath: string;
  rawAttributionPath: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  generatedAt?: string;
  generatorCommit?: string;
}

export interface A2aLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  refs: {
    bundleDir: string;
    snapshotRef: string;
    attributionRefs: string[];
  };
  isLive: true;
  sentCrossThreadMessage: false;
}

interface ParsedMarkdownYaml {
  frontmatter: Record<string, unknown>;
  body: Record<string, unknown>;
}

type RawRecord = Record<string, unknown>;

export function generateA2aLiveVerdict(input: GenerateA2aLiveVerdictInput): A2aLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  const rawSnapshot = parseSnapshot(input.rawSnapshotPath);
  const rawAttribution = parseAttribution(input.rawAttributionPath);
  if (rawSnapshot.featureId !== rawAttribution.featureId) {
    throw new Error(
      `raw artifact feature mismatch: snapshot=${rawSnapshot.featureId} attribution=${rawAttribution.featureId}`,
    );
  }
  if (rawSnapshot.evalSnapshotId !== rawAttribution.evalSnapshotId) {
    throw new Error(
      `raw artifact eval snapshot mismatch: snapshot=${rawSnapshot.evalSnapshotId} attribution=${rawAttribution.evalSnapshotId}`,
    );
  }

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const selectedFinding = strongestFinding(rawAttribution.findings);
  const citedComponentIds = selectedFinding
    ? new Set(selectedFinding.attribution.evidence.map((evidence) => evidence.anchor.split('/')[0]))
    : new Set(rawSnapshot.components.map((component) => component.id));

  const snapshotBundle = {
    verdictId: input.verdictId,
    evalSnapshotId: rawSnapshot.evalSnapshotId,
    featureId: rawSnapshot.featureId,
    generatedAt: rawSnapshot.generatedAt,
    window: rawSnapshot.window,
    components: rawSnapshot.components.filter((component) => citedComponentIds.has(component.id)),
  };
  const attributionBundle = {
    verdictId: input.verdictId,
    featureId: rawAttribution.featureId,
    evalSnapshotId: rawAttribution.evalSnapshotId,
    generatedAt: rawAttribution.generatedAt,
    findings: selectedFinding ? [selectedFinding] : [],
    ...(selectedFinding ? {} : { noFindingRecord: rawAttribution.noFindingRecord }),
  };
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: repoRelativeRawInputPath(input.rawSnapshotPath, input.harnessFeedbackRoot),
        sha256: sha256File(input.rawSnapshotPath),
      },
      {
        path: repoRelativeRawInputPath(input.rawAttributionPath, input.harnessFeedbackRoot),
        sha256: sha256File(input.rawAttributionPath),
      },
    ],
    generatedAt: input.generatedAt ?? rawAttribution.generatedAt,
    generator: {
      name: 'eval-a2a-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshotBundle);
  writeJson(join(bundleDir, 'attribution.json'), attributionBundle);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const packet = buildA2aVerdictHandoff({
    domain: input.domain,
    snapshot: resolved.snapshot,
    attributionReport: resolved.attributionReport,
  });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...packet,
    evidencePacket: {
      ...packet.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatLiveVerdictMarkdown(input.verdictId, packetWithBundleRefs, resolved.snapshotRef);
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet: packetWithBundleRefs,
    markdown,
    refs: {
      bundleDir,
      snapshotRef: resolved.snapshotRef,
      attributionRefs: resolved.attributionRefs,
    },
    isLive: true,
    sentCrossThreadMessage: false,
  };
}

function parseSnapshot(path: string) {
  const parsed = parseMarkdownYaml(path);
  const featureId = stringValue(parsed.frontmatter.feature_id, 'snapshot feature_id');
  const generatedAt = stringValue(parsed.frontmatter.generated_at, 'snapshot generated_at');
  const components = arrayOfRecords(parsed.body.components).map((component) => ({
    id: stringValue(component.id, 'snapshot component id'),
    name: stringValue(component.name, 'snapshot component name'),
    confidence: stringValue(component.confidence ?? 'medium', 'snapshot component confidence'),
    activationCounts: countRecord(component.activation_counts),
    frictionCounts: countRecord(component.friction_counts),
  }));
  return {
    featureId,
    evalSnapshotId:
      optionalStringValue(parsed.frontmatter.eval_snapshot_id, 'snapshot eval_snapshot_id') ??
      evalSnapshotIdFromGeneratedAt(featureId, generatedAt),
    generatedAt,
    window: {
      startMs: optionalNumber(recordValue(parsed.body.window).start_ms),
      endMs: optionalNumber(recordValue(parsed.body.window).end_ms),
      durationHours: numberValue(recordValue(parsed.body.window).duration_hours, 'snapshot window duration_hours'),
    },
    components,
  };
}

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}

function evalSnapshotIdFromGeneratedAt(featureId: string, generatedAt: string): string {
  const date = generatedAt.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) throw new Error('snapshot generated_at must start with YYYY-MM-DD');
  return `eval-${featureId}-${date}`;
}

function parseAttribution(path: string) {
  const parsed = parseMarkdownYaml(path);
  const findings = arrayOfRecords(parsed.body.findings).map((finding) => {
    const relatedFeature = optionalStringValue(finding.related_feature, 'attribution related_feature');
    const attribution = recordValue(finding.attribution);
    const pipelineOrHuman = optionalStringValue(attribution.pipeline_or_human, 'attribution pipeline_or_human');
    return {
      id: stringValue(finding.id, 'attribution finding id'),
      ...(relatedFeature ? { relatedFeature } : {}),
      frictionSignal: {
        type: stringValue(recordValue(finding.friction_signal).type, 'attribution friction signal type'),
        severity: severityValue(recordValue(finding.friction_signal).severity),
        confidence: numberValue(recordValue(finding.friction_signal).confidence, 'attribution confidence'),
      },
      attribution: {
        primaryLayer: stringValue(attribution.primary_layer, 'attribution primary_layer'),
        ...(pipelineOrHuman ? { pipelineOrHuman } : {}),
        evidence: arrayOfRecords(attribution.evidence).map((evidence) => ({
          type: stringValue(evidence.type, 'attribution evidence type'),
          anchor: stringValue(evidence.anchor, 'attribution evidence anchor'),
          excerpt: stringValue(evidence.excerpt, 'attribution evidence excerpt'),
        })),
      },
      proposedAction: arrayOfRecords(finding.proposed_action).map((action) => ({
        action: stringValue(action.action, 'attribution proposed_action action'),
        target: stringValue(action.target, 'attribution proposed_action target'),
        rationale: stringValue(action.rationale, 'attribution proposed_action rationale'),
      })),
      status: stringValue(finding.status ?? 'open', 'attribution status'),
    };
  });
  const noFinding = parsed.body.no_finding_record ? recordValue(parsed.body.no_finding_record) : undefined;
  return {
    featureId: stringValue(parsed.frontmatter.feature_id, 'attribution feature_id'),
    evalSnapshotId: stringValue(parsed.frontmatter.eval_snapshot_id, 'attribution eval_snapshot_id'),
    generatedAt: stringValue(parsed.frontmatter.generated_at, 'attribution generated_at'),
    findings,
    ...(noFinding
      ? {
          noFindingRecord: {
            reason: stringValue(noFinding.reason, 'attribution no_finding_record reason'),
            evidence: stringValue(noFinding.evidence, 'attribution no_finding_record evidence'),
          },
        }
      : {}),
  };
}

function parseMarkdownYaml(path: string): ParsedMarkdownYaml {
  const raw = readFileSync(path, 'utf8');
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) throw new Error(`missing YAML frontmatter: ${path}`);
  const body = raw.slice(frontmatterMatch[0].length);
  const bodyYaml = body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return {
    frontmatter: asRecord(parseYaml(frontmatterMatch[1] ?? '')),
    body: asRecord(parseYaml(bodyYaml) ?? {}),
  };
}

/**
 * F167 Path A: end-to-end no-data verdict writer.
 *
 * Replaces the hand-written 2026-06-01..06-03 packets. Given structured
 * `BuildA2aNoDataVerdictInput`, this:
 *   1. Compiles a standard `VerdictHandoffPacket` via the no-data builder
 *      (so the cross-thread handoff gate stays honest).
 *   2. Materializes `bundle/<verdictId>/{snapshot,attribution,provenance}.json`
 *      with the same field shape the eval cat has been writing by hand
 *      (so existing Eval Hub consumers keep working without migration).
 *   3. Writes `verdicts/<verdictId>.md` with the standard frontmatter,
 *      plus the embedded `## Verdict Handoff Packet` JSON block and
 *      `## Legacy Scheduled Task Status` section the eval cat has been
 *      appending manually.
 *
 * Callers only need to supply structured input — they no longer have to
 * remember the bundle/markdown conventions or risk schema drift.
 */
export interface GenerateA2aNoDataVerdictInput extends BuildA2aNoDataVerdictInput {
  harnessFeedbackRoot: string;
  /** Optional generator commit for provenance auditability. */
  generatorCommit?: string;
}

export function generateA2aNoDataVerdict(input: GenerateA2aNoDataVerdictInput): A2aLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);

  const packet = buildA2aNoDataVerdictHandoff(input);

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictDir = join(input.harnessFeedbackRoot, 'verdicts');
  const verdictPath = join(verdictDir, `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(verdictDir, { recursive: true });

  const evalSnapshotId = `eval-${packet.harnessUnderEval.featureId}-${input.verdictId}`;
  const snapshotBundle = buildNoDataSnapshotBundle(input, packet, evalSnapshotId);
  const attributionBundle = buildNoDataAttributionBundle(input, packet, evalSnapshotId);
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [],
    generatedAt: input.generatedAt,
    generator: {
      name: 'eval-a2a-no-data-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
    inputFingerprint: fingerprintInput(input),
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshotBundle);
  writeJson(join(bundleDir, 'attribution.json'), attributionBundle);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const snapshotRef = packet.evidencePacket.snapshotRefs[0] ?? `snapshot:bundle/${input.verdictId}/snapshot`;
  const attributionRefs = packet.evidencePacket.attributionRefs;
  const markdown = formatNoDataVerdictMarkdown(input, packet, snapshotRef);
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet,
    markdown,
    refs: {
      bundleDir,
      snapshotRef,
      attributionRefs,
    },
    isLive: true,
    sentCrossThreadMessage: false,
  };
}

function buildNoDataSnapshotBundle(
  input: GenerateA2aNoDataVerdictInput,
  packet: VerdictHandoffPacket,
  evalSnapshotId: string,
): Record<string, unknown> {
  return {
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId: packet.harnessUnderEval.featureId,
    generatedAt: input.generatedAt,
    window: input.window,
    sourceAdapter: input.domain.sourceAdapter,
    ...(input.previousVerdict
      ? {
          previousVerdictRef: input.previousVerdict.packetId,
          closureCheck: {
            previousClosureCondition: input.previousVerdict.closureCondition,
            closureMet: input.previousVerdict.closureMet,
            reason: input.previousVerdict.reason,
          },
        }
      : {}),
    ...(input.ownerActionStatus ? { ownerActionStatus: input.ownerActionStatus } : {}),
    legacyScheduledTaskStatus: input.legacyScheduledTaskStatus,
    dailySchedulerStatus: input.dailySchedulerStatus,
    components: [
      {
        id: 'source-adapter',
        name: packet.harnessUnderEval.name,
        confidence: 'no-data',
        activationCounts: noDataActivationCounts(input),
        frictionCounts: noDataFrictionCounts(packet),
      },
      {
        id: 'legacy-cleanup',
        name: 'legacy scheduled-task overlap guard',
        confidence: 'high',
        activationCounts: {
          [`legacyScheduledTaskIds.${input.legacyScheduledTaskStatus.taskIds.join(',') || 'none'}`]: 1,
          [`legacyCleanup.${input.legacyScheduledTaskStatus.cleanupStatus}`]: 1,
        },
        frictionCounts: {
          legacy_task_overlap_count: input.legacyScheduledTaskStatus.activeLegacyOverlap,
          duplicate_trigger_count: input.dailySchedulerStatus.duplicateCronSlotFires,
        },
      },
    ],
    endpointChecks: input.noDataReason.endpointProbes,
  };
}

function noDataActivationCounts(input: GenerateA2aNoDataVerdictInput): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [day, n] of Object.entries(input.dailySchedulerStatus.invocationsPerSlot)) {
    counts[`eval-domain-daily.invocations_${day}`] = n;
  }
  return counts;
}

function noDataFrictionCounts(packet: VerdictHandoffPacket): Record<string, number> {
  return packet.dailyTrend.current;
}

function buildNoDataAttributionBundle(
  input: GenerateA2aNoDataVerdictInput,
  packet: VerdictHandoffPacket,
  evalSnapshotId: string,
): Record<string, unknown> {
  const evidence: Array<{ type: string; anchor: string; excerpt: string }> = [];
  for (const probe of input.noDataReason.endpointProbes) {
    evidence.push({
      type: 'endpoint_check',
      anchor: `source-adapter/${probe.endpoint}`,
      excerpt: `${probe.endpoint} returned ${probe.status}: ${probe.result}`,
    });
  }
  if (input.ownerActionStatus) {
    evidence.push({
      type: 'owner_action',
      anchor: `branch/${input.ownerActionStatus.branch}`,
      excerpt: `Owner branch ${input.ownerActionStatus.branch} reached ${input.ownerActionStatus.latestCommit}; review status: ${input.ownerActionStatus.reviewStatus}.${input.ownerActionStatus.notes ? ' ' + input.ownerActionStatus.notes : ''}`,
    });
  }
  if (input.previousVerdict) {
    evidence.push({
      type: 'previous_verdict',
      anchor: `verdict/${input.previousVerdict.packetId}`,
      excerpt: `Previous closure condition (${input.previousVerdict.closureCondition}) closureMet=${input.previousVerdict.closureMet}: ${input.previousVerdict.reason}`,
    });
  }
  return {
    verdictId: input.verdictId,
    featureId: packet.harnessUnderEval.featureId,
    evalSnapshotId,
    generatedAt: input.generatedAt,
    findings: [
      {
        id: 'source-adapter-unavailable',
        relatedFeature: 'F192',
        frictionSignal: {
          type: 'source_adapter_unavailable',
          severity: 'medium',
          confidence: 0.95,
        },
        attribution: {
          primaryLayer: 'environment_drift',
          pipelineOrHuman: 'pipeline',
          evidence,
        },
        proposedAction: [
          {
            action: 'restore-or-degrade-source-adapter',
            target: input.domain.sourceAdapter,
            rationale: input.noDataReason.summary,
          },
        ],
        status: 'open',
      },
    ],
  };
}

function fingerprintInput(input: GenerateA2aNoDataVerdictInput): string {
  const stable = {
    verdictId: input.verdictId,
    generatedAt: input.generatedAt,
    probes: input.noDataReason.endpointProbes,
    legacy: input.legacyScheduledTaskStatus,
    scheduler: input.dailySchedulerStatus,
    ownerAction: input.ownerActionStatus ?? null,
    previous: input.previousVerdict ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

function formatNoDataVerdictMarkdown(
  input: GenerateA2aNoDataVerdictInput,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
): string {
  const lines: string[] = [
    '---',
    'feature_ids: [F192, F167]',
    'topics: [harness-eval, eval-a2a, source-adapter, live-verdict, no-data]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:a2a',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${input.verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (${packet.harnessUnderEval.name})`,
  ];
  if (input.ownerActionStatus) {
    lines.push(
      `- Owner action observed: ${input.ownerActionStatus.branch}@${input.ownerActionStatus.latestCommit} (${input.ownerActionStatus.reviewStatus})${input.ownerActionStatus.notes ? ' — ' + input.ownerActionStatus.notes : ''}`,
    );
  }
  lines.push(
    `- Owner ask: ${packet.ownerAsk.requestedAction}`,
    `- Re-eval: ${packet.acceptanceReevalPlan.closureCondition} (next at ${packet.acceptanceReevalPlan.nextEvalAt})`,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref}`),
    ...packet.evidencePacket.sampleTraceRefs.map((ref) => `- ${ref}`),
    '',
    '## Verdict Handoff Packet',
    '',
    '```json',
    JSON.stringify(packet, null, 2),
    '```',
    '',
    '## Legacy Scheduled Task Status',
    '',
    `- Tasks: ${input.legacyScheduledTaskStatus.taskIds.join(', ') || '(none)'}`,
    `- Cleanup status: \`${input.legacyScheduledTaskStatus.cleanupStatus}\``,
    `- Active overlap: ${input.legacyScheduledTaskStatus.activeLegacyOverlap}`,
    `- Daily slot ${input.dailySchedulerStatus.currentSlot} fires: ${input.dailySchedulerStatus.invocationsPerSlot[ymdFromSlot(input.dailySchedulerStatus.currentSlot)] ?? 'n/a'} (duplicates: ${input.dailySchedulerStatus.duplicateCronSlotFires})`,
    '',
    'Counterarguments:',
    ...packet.counterarguments.map((counterargument) => `- ${counterargument}`),
    '',
  );
  return lines.join('\n');
}

function ymdFromSlot(slot: string): string {
  return slot.slice(0, 10);
}

function formatLiveVerdictMarkdown(verdictId: string, packet: VerdictHandoffPacket, sourceSnapshotRef: string): string {
  return [
    '---',
    'feature_ids: [F192, F167]',
    'topics: [harness-eval, eval-a2a, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:a2a',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (${packet.harnessUnderEval.name})`,
    `- Owner ask: ${packet.ownerAsk.requestedAction}`,
    `- Re-eval: ${packet.acceptanceReevalPlan.closureCondition} at ${packet.acceptanceReevalPlan.nextEvalAt}`,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref}`),
    ...packet.evidencePacket.sampleTraceRefs.map((ref) => `- ${ref}`),
    '',
    'Counterarguments:',
    ...packet.counterarguments.map((counterargument) => `- ${counterargument}`),
    '',
  ].join('\n');
}

function strongestFinding(findings: ReturnType<typeof parseAttribution>['findings'][number][]) {
  if (findings.length === 0) return undefined;
  return findings.reduce((strongest, candidate) =>
    findingRank(candidate) > findingRank(strongest) ? candidate : strongest,
  );
}

function findingRank(finding: ReturnType<typeof parseAttribution>['findings'][number]): number {
  const severity =
    finding.frictionSignal.severity === 'high' ? 3 : finding.frictionSignal.severity === 'medium' ? 2 : 1;
  return severity * 1_000 + finding.frictionSignal.confidence;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repoRelativeRawInputPath(rawPath: string, harnessFeedbackRoot: string): string {
  const normalizedRawPath = normalize(rawPath);
  if (!isAbsolute(normalizedRawPath)) {
    if (isPathOutsideRoot(normalizedRawPath)) {
      throw new Error('raw input path must be inside the repository root');
    }
    return toPosixPath(normalizedRawPath);
  }

  const repoRoot = resolve(dirname(dirname(harnessFeedbackRoot)));
  const relativePath = relative(repoRoot, normalizedRawPath);
  if (isPathOutsideRoot(relativePath)) {
    throw new Error('raw input path must be inside the repository root');
  }
  return toPosixPath(relativePath);
}

function isPathOutsideRoot(path: string): boolean {
  return path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path);
}

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function countRecord(value: unknown): Record<string, number | null> {
  const record = recordValue(value, false);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, count]) => [key, count == null ? null : numberValue(count, key)]),
  );
}

function severityValue(value: unknown): 'low' | 'medium' | 'high' {
  const severity = stringValue(value, 'attribution severity');
  if (severity === 'low' || severity === 'medium' || severity === 'high') return severity;
  throw new Error(`invalid attribution severity: ${severity}`);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`${name} must be a finite number`);
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  return numberValue(value, 'optional number');
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${name} must be a non-empty string`);
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  return stringValue(value, name);
}

function arrayOfRecords(value: unknown): RawRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item));
}

function recordValue(value: unknown, required = true): RawRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RawRecord;
  if (!required) return {};
  throw new Error('expected YAML object');
}

function asRecord(value: unknown): RawRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RawRecord;
  return {};
}
