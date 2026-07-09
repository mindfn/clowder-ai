/**
 * YAML serializer for F167 eval:a2a evidence artifacts.
 *
 * Produces the markdown-YAML format consumed by `parseSnapshot` and
 * `parseAttribution` in eval-a2a-artifact-parsers.ts. Fields are
 * snake_case in the body (to match what the parsers expect), while
 * frontmatter field names match the parser's lookups exactly.
 *
 * File-size boundary: no logic beyond serialization lives here.
 * Evidence production logic lives in eval-a2a-evidence-producer.ts.
 */

import { stringify as stringifyYaml } from 'yaml';
import type { AttributionRecord, AttributionReport } from '../attribution.js';
import type { RuntimeEvalSnapshot } from '../f167-eval.js';

/** Write the snapshot as markdown-YAML loadable by `parseSnapshot`. */
export function formatSnapshotYaml(snapshot: RuntimeEvalSnapshot): string {
  const date = snapshot.generatedAt.slice(0, 10);
  const frontmatter = {
    doc_kind: 'harness-feedback',
    feedback_type: 'eval-snapshot',
    feature_id: snapshot.featureId,
    generated_at: snapshot.generatedAt,
  };

  const windowBody: Record<string, number | undefined> = {
    start_ms: snapshot.window.startMs,
    end_ms: snapshot.window.endMs,
    duration_hours: snapshot.window.durationHours,
  };

  const counterWindowBody = snapshot.counterWindow
    ? {
        start_ms: snapshot.counterWindow.startMs,
        end_ms: snapshot.counterWindow.endMs,
        duration_hours: snapshot.counterWindow.durationHours,
      }
    : undefined;

  const componentsBody = snapshot.components.map((c) => ({
    id: c.componentId,
    name: c.componentName,
    confidence: c.confidence,
    activation_counts: c.activationCounts,
    friction_counts: c.frictionCounts,
  }));

  const body: Record<string, unknown> = {
    window: windowBody,
    ...(counterWindowBody ? { counter_window: counterWindowBody } : {}),
    components: componentsBody,
  };

  return [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    `# F167 Runtime Eval Snapshot — ${date}`,
    '',
    stringifyYaml(body).trimEnd(),
    '',
  ].join('\n');
}

/** Write the attribution report as markdown-YAML loadable by `parseAttribution`. */
export function formatAttributionYaml(report: AttributionReport): string {
  const date = report.generatedAt.slice(0, 10);
  const frontmatter = {
    doc_kind: 'harness-feedback',
    feedback_type: 'attribution',
    feature_id: report.featureId,
    eval_snapshot_id: report.evalSnapshotId,
    generated_at: report.generatedAt,
  };

  const findingsBody = report.findings.map((f) => formatFindingBody(f));

  const body: Record<string, unknown> = {
    ...(findingsBody.length > 0 ? { findings: findingsBody } : { findings: [] }),
    ...(report.noFindingRecord
      ? {
          no_finding_record: {
            reason: report.noFindingRecord.reason,
            evidence: report.noFindingRecord.evidence,
          },
        }
      : {}),
  };

  return [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    `# F167 Attribution Report — ${date}`,
    '',
    stringifyYaml(body).trimEnd(),
    '',
  ].join('\n');
}

function formatFindingBody(f: AttributionRecord): Record<string, unknown> {
  return {
    id: f.id,
    related_feature: f.relatedFeature,
    friction_signal: {
      type: f.frictionSignal.type,
      severity: f.frictionSignal.severity,
      confidence: f.frictionSignal.confidence,
      ...(f.frictionSignal.detectedAt ? { detected_at: f.frictionSignal.detectedAt } : {}),
    },
    attribution: {
      primary_layer: f.attribution.primaryLayer,
      ...(f.attribution.pipelineOrHuman ? { pipeline_or_human: f.attribution.pipelineOrHuman } : {}),
      evidence: f.attribution.evidence.map((e) => ({
        type: e.type,
        anchor: e.anchor,
        excerpt: e.excerpt,
      })),
    },
    proposed_action: f.proposedAction.map((a) => ({
      action: a.action,
      target: a.target,
      rationale: a.rationale,
    })),
    status: f.status,
    ...(f.sampleCoverage
      ? {
          sample_coverage: {
            sample_count: f.sampleCoverage.sampleCount,
            metric_count: f.sampleCoverage.metricCount,
            complete: f.sampleCoverage.complete,
          },
        }
      : {}),
  };
}
