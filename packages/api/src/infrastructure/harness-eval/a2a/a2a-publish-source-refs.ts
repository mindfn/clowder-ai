import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { LocalTraceStore, TraceSpanDTO } from '../../telemetry/local-trace-store.js';
import { type MetricsSnapshotStore, parsePrometheusText } from '../../telemetry/metrics-snapshot-store.js';
import { type AttributionReport, generateAttributionReport } from '../attribution.js';
import { type F167EvalInput, generateF167Snapshot, type RuntimeEvalSnapshot } from '../f167-eval.js';
import type { A2aSnapshotAttributionRefs } from '../publish-verdict/types.js';
import type { EvalMetricsHistoryResponse, EvalTraceSpan } from '../telemetry-adapter.js';

export interface A2aPublishSourceRefsResult extends Required<A2aSnapshotAttributionRefs> {
  snapshotPath: string;
  attributionPath: string;
}

export interface WriteA2aPublishSourceRefsInput extends F167EvalInput {
  harnessFeedbackRoot: string;
  generatedAt?: string;
}

export interface A2aPublishSourceRefsProducerDeps {
  harnessFeedbackRoot: string;
  traceStore?: Pick<LocalTraceStore, 'query' | 'stats'> | null;
  getMetricsText?: (() => Promise<string>) | null;
  metricsSnapshotStore?: Pick<MetricsSnapshotStore, 'query'> | null;
  now?: () => number;
}

export function writeA2aPublishSourceRefs(input: WriteA2aPublishSourceRefsInput): A2aPublishSourceRefsResult {
  const baseSnapshot = generateF167Snapshot(input);
  const generatedAt = input.generatedAt ?? baseSnapshot.generatedAt;
  const snapshot: RuntimeEvalSnapshot = { ...baseSnapshot, generatedAt };
  const date = generatedAt.slice(0, 10);
  const evalSnapshotId = `eval-${snapshot.featureId}-${date}`;
  const attribution = withAttributionIds(generateAttributionReport({ featureId: snapshot.featureId, snapshot }), {
    evalSnapshotId,
    generatedAt,
  });

  const slug = generatedAt.replace(/[:.]/g, '-').replace(/[^A-Za-z0-9-]/g, '-');
  const snapshotName = `${slug}-${snapshot.featureId}-eval.yaml`;
  const attributionName = `${slug}-${snapshot.featureId}-attribution.yaml`;
  const snapshotPath = join(input.harnessFeedbackRoot, 'snapshots', snapshotName);
  const attributionPath = join(input.harnessFeedbackRoot, 'attributions', attributionName);

  mkdirSync(join(input.harnessFeedbackRoot, 'snapshots'), { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'attributions'), { recursive: true });
  writeFileSync(snapshotPath, renderSnapshotYaml(snapshot, evalSnapshotId), 'utf8');
  writeFileSync(attributionPath, renderAttributionYaml(attribution), 'utf8');

  return {
    kind: 'a2a-snapshot-attribution',
    snapshotName,
    attributionName,
    snapshotPath,
    attributionPath,
  };
}

export function createA2aPublishSourceRefsProducer(
  deps: A2aPublishSourceRefsProducerDeps,
): () => Promise<A2aPublishSourceRefsResult> {
  return async () => {
    const input = await readF167EvalInput(deps);
    return writeA2aPublishSourceRefs({
      ...input,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      ...(deps.now ? { generatedAt: new Date(deps.now()).toISOString() } : {}),
    });
  };
}

async function readF167EvalInput(deps: A2aPublishSourceRefsProducerDeps): Promise<F167EvalInput> {
  const traceStats = deps.traceStore?.stats() ?? {
    spanCount: 0,
    maxSpans: 10_000,
    maxAgeMs: 24 * 60 * 60 * 1000,
    oldestStoredAt: null,
    newestStoredAt: null,
  };
  const traceDtos = deps.traceStore?.query({ limit: traceStats.maxSpans }) ?? [];
  const metrics = await readMetrics(deps.getMetricsText ?? undefined);
  const metricsHistory = readMetricsHistory(deps.metricsSnapshotStore ?? undefined);
  return {
    traces: { spans: traceDtos.map(toEvalTraceSpan), count: traceDtos.length },
    metrics,
    metricsHistory,
    traceStats,
  };
}

async function readMetrics(getMetricsText?: () => Promise<string>): Promise<Record<string, number>> {
  if (!getMetricsText) return {};
  try {
    return parsePrometheusText(await getMetricsText());
  } catch {
    return {};
  }
}

function readMetricsHistory(store?: Pick<MetricsSnapshotStore, 'query'>): EvalMetricsHistoryResponse {
  const snapshots = store?.query(undefined, 720) ?? [];
  return { snapshots, count: snapshots.length };
}

function toEvalTraceSpan(dto: TraceSpanDTO): EvalTraceSpan {
  return {
    traceId: dto.traceId,
    spanId: dto.spanId,
    ...(dto.parentSpanId ? { parentSpanId: dto.parentSpanId } : {}),
    name: dto.name,
    startTimeMs: dto.startTimeMs,
    endTimeMs: dto.endTimeMs,
    durationMs: dto.durationMs,
    status: dto.status,
    attributes: dto.attributes,
    events: dto.events,
  };
}

function withAttributionIds(
  report: AttributionReport,
  ids: { evalSnapshotId: string; generatedAt: string },
): AttributionReport {
  return {
    ...report,
    evalSnapshotId: ids.evalSnapshotId,
    generatedAt: ids.generatedAt,
  };
}

function renderSnapshotYaml(snapshot: RuntimeEvalSnapshot, evalSnapshotId: string): string {
  return renderRawYaml(
    {
      doc_kind: 'harness-feedback',
      feedback_type: 'eval-snapshot',
      feature_id: snapshot.featureId,
      eval_snapshot_id: evalSnapshotId,
      generated_at: snapshot.generatedAt,
    },
    {
      window: {
        start_ms: snapshot.window.startMs,
        end_ms: snapshot.window.endMs,
        duration_hours: snapshot.window.durationHours,
      },
      components: snapshot.components.map((component) => ({
        id: component.componentId,
        name: component.componentName,
        confidence: component.confidence,
        activation_counts: component.activationCounts,
        friction_counts: component.frictionCounts,
      })),
    },
  );
}

function renderAttributionYaml(report: AttributionReport): string {
  return renderRawYaml(
    {
      doc_kind: 'harness-feedback',
      feedback_type: 'attribution',
      feature_id: report.featureId,
      eval_snapshot_id: report.evalSnapshotId,
      generated_at: report.generatedAt,
    },
    {
      finding_count: report.findings.length,
      findings: report.findings.map((finding) => ({
        id: finding.id,
        ...(finding.relatedFeature ? { related_feature: finding.relatedFeature } : {}),
        friction_signal: {
          type: finding.frictionSignal.type,
          severity: finding.frictionSignal.severity,
          confidence: finding.frictionSignal.confidence,
          detected_at: finding.frictionSignal.detectedAt,
        },
        attribution: {
          primary_layer: finding.attribution.primaryLayer,
          pipeline_or_human: finding.attribution.pipelineOrHuman,
          evidence: finding.attribution.evidence.map((evidence) => ({
            type: evidence.type,
            anchor: evidence.anchor,
            excerpt: evidence.excerpt,
          })),
        },
        proposed_action: finding.proposedAction,
        status: finding.status,
      })),
      ...(report.noFindingRecord
        ? {
            no_finding_record: {
              reason: report.noFindingRecord.reason,
              evidence: report.noFindingRecord.evidence,
            },
          }
        : {}),
    },
  );
}

function renderRawYaml(frontmatter: Record<string, unknown>, body: Record<string, unknown>): string {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${stringifyYaml(body).trimEnd()}\n`;
}
