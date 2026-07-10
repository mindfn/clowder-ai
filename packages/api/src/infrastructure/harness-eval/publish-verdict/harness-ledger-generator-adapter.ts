/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter.
 *
 * Converts GuardRejectionEventLog time-window data into eval:harness-ledger
 * verdict + bundle artifacts (snapshot / attribution / provenance).
 *
 * Follows the QC adapter pattern (Phase C bootstrap):
 *   1. Discriminator: sourceRefs.kind === 'prompt-segments'
 *   2. Validate window (start < end, both finite)
 *   3. Resolve data: guardRejectionLog.queryWindow(selector)
 *   4. Write verdict markdown + bundle artifacts
 *   5. Return paths
 *
 * The adapter is fail-closed: uses queryWindowStrict() which propagates
 * Redis errors (unlike the business-facing fail-open queryWindow()).
 * Redis outage → generator throws → publish returns 500 to eval cat →
 * no false "zero events" verdict is written. Genuine zero events are
 * a valid outcome (keep_observe with noFindingRecord).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardRejectionEventLog } from '../GuardRejectionEventLog.js';
import type { PromptSegmentsSourceSelector, VerdictGenerator } from './types.js';

export function createHarnessLedgerGeneratorAdapter(guardRejectionLog: GuardRejectionEventLog): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Step 1: discriminator check
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'prompt-segments') {
      throw new Error(
        `harness_ledger_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'prompt-segments'`,
      );
    }

    const selector = sourceRefs as unknown as PromptSegmentsSourceSelector;

    // Step 2: validate window
    if (!Number.isFinite(selector.windowStartMs) || !Number.isFinite(selector.windowEndMs)) {
      throw new Error('invalid_window: windowStartMs and windowEndMs must be finite numbers');
    }
    if (selector.windowEndMs <= selector.windowStartMs) {
      throw new Error('invalid_window: windowEndMs must be greater than windowStartMs');
    }

    // Step 3: resolve data from GuardRejectionEventLog (strict = fail-closed).
    // P1 fix (codex review 04a8c368b): queryWindow is fail-open (returns []
    // on Redis error), which would produce false "zero events" verdicts.
    // queryWindowStrict propagates Redis errors → generator throws → 500.
    const events = await guardRejectionLog.queryWindowStrict({
      since: selector.windowStartMs,
      until: selector.windowEndMs,
      ...(selector.guardId ? { guardId: selector.guardId } : {}),
    });

    const generatedAt = new Date().toISOString();
    const evalSnapshotId = `harness-ledger-snapshot-${packet.id}`;
    const windowMs = selector.windowEndMs - selector.windowStartMs;
    // P1 fix (codex review 04a8c368b): bundleSnapshotSchema enforces
    // durationHours (not durationDays) — align with QC/friction adapters.
    const windowHours = Math.round(windowMs / (3600 * 1000));
    const windowDays = Math.round(windowMs / (24 * 3600 * 1000));

    // Aggregate by kind
    const byKind: Record<string, number> = {};
    for (const e of events) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }

    // Aggregate by guardId
    const byGuard: Record<string, number> = {};
    for (const e of events) {
      byGuard[e.guardId] = (byGuard[e.guardId] ?? 0) + 1;
    }

    // Step 4: write bundle artifacts
    const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
    mkdirSync(join(deps.harnessFeedbackRoot, 'verdicts'), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    // --- Bundle: snapshot.json ---
    const bundleSnapshot = {
      verdictId: packet.id,
      evalSnapshotId,
      featureId: 'F257',
      generatedAt,
      window: {
        startMs: selector.windowStartMs,
        endMs: selector.windowEndMs,
        durationHours: windowHours,
      },
      ...(selector.guardId ? { guardIdFilter: selector.guardId } : {}),
      totalEvents: events.length,
      byKind,
      byGuard,
      components: [
        {
          componentId: 'guard-rejection-log',
          componentName: 'Guard Rejection Event Log',
          activationCounts: {
            total_events: events.length,
            ...byKind,
          },
          frictionCounts: byGuard,
          confidence: events.length === 0 ? 'no-data' : 'medium',
        },
      ],
    };
    const snapshotJson = JSON.stringify(bundleSnapshot, null, 2);
    writeFileSync(join(bundleDir, 'snapshot.json'), snapshotJson);

    // --- Bundle: attribution.json ---
    // P1 fix (codex review): findings must conform to attributionFindingSchema
    // (eval-a2a-artifact-resolver.ts L76-98). Each finding needs id, frictionSignal,
    // attribution (with evidence anchored to snapshot components), proposedAction.
    // assertAttributionAnchors validates evidence anchors match snapshot metric keys.
    const hasEvents = events.length > 0;
    const attribution = {
      verdictId: packet.id,
      featureId: 'F257',
      evalSnapshotId,
      generatedAt,
      findings: hasEvents
        ? Object.entries(byGuard).map(([guardId, count]) => {
            const guardEvents = events.filter((e) => e.guardId === guardId);
            const kinds = [...new Set(guardEvents.map((e) => e.kind))];
            const severity: 'low' | 'medium' | 'high' = count >= 20 ? 'high' : count >= 5 ? 'medium' : 'low';
            return {
              id: `f257-guard-${guardId}`,
              frictionSignal: {
                type: kinds.join('+'),
                severity,
                confidence: 0.7,
              },
              attribution: {
                primaryLayer: 'guard-rejection-log',
                // Evidence anchors: guard-rejection-log/<kind> links to
                // snapshot.components[0].activationCounts[kind].
                evidence: kinds.map((kind) => ({
                  type: 'activation-count',
                  anchor: `guard-rejection-log/${kind}`,
                  excerpt: `${guardEvents.filter((e) => e.kind === kind).length} ${kind} rejection(s) by guard ${guardId}`,
                })),
              },
              proposedAction: [
                {
                  action: 'review',
                  target: guardId,
                  rationale: `${count} guard rejection(s) in window — review for operational pattern`,
                },
              ],
            };
          })
        : [],
      ...(hasEvents
        ? {}
        : {
            noFindingRecord: {
              reason: 'No guard rejection events recorded in this window',
              evidence: `Zero events in ${windowDays}-day window [${selector.windowStartMs}, ${selector.windowEndMs}). Possible causes: guards not triggered, or event log not yet accumulating.`,
            },
          }),
    };
    writeFileSync(join(bundleDir, 'attribution.json'), JSON.stringify(attribution, null, 2));

    // --- Bundle: provenance.json ---
    const snapshotSha = createHash('sha256').update(snapshotJson).digest('hex');
    const provenance = {
      verdictId: packet.id,
      rawInputs: [
        {
          path: `bundles/${packet.id}/snapshot.json`,
          sha256: snapshotSha,
        },
      ],
      generatedAt,
      generator: {
        name: 'harness-ledger-generator-adapter',
        version: '1.0.0',
      },
      sanitizeRulesVersion: '1.0.0',
    };
    writeFileSync(join(bundleDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

    // --- Evidence refs ---
    const snapshotRef = `snapshot:bundle/${packet.id}/snapshot`;
    const attributionRef = hasEvents
      ? `attribution:bundle/${packet.id}/${evalSnapshotId}`
      : `attribution:bundle/${packet.id}/${evalSnapshotId}:no-finding`;

    // --- Verdict markdown (Eval Hub compatible) ---
    const typedPacket = packet as Record<string, unknown>;

    const verdictValue = (typedPacket.verdict as string) ?? 'keep_observe';
    const phenomenonDefault =
      events.length === 0
        ? 'Zero guard rejection events in window — baseline accumulation phase'
        : `${events.length} guard rejection events across ${Object.keys(byGuard).length} guard(s)`;
    const phenomenon = (typedPacket.phenomenon as string) ?? phenomenonDefault;

    const hue = typedPacket.harnessUnderEval as { featureId?: string; componentId?: string; name?: string } | undefined;
    const harnessLine = hue
      ? `${hue.featureId}/${hue.componentId} (${hue.name})`
      : 'F257/guard-rejection-log (Harness Ledger)';

    const ownerAskObj = typedPacket.ownerAsk as { requestedAction?: string } | undefined;
    const ownerAskLine =
      ownerAskObj?.requestedAction ??
      (events.length === 0
        ? 'No action required; keep observing until guard rejection events accumulate.'
        : `Review ${events.length} rejection events for attribution patterns.`);

    const reevalPlan = typedPacket.acceptanceReevalPlan as { nextEvalAt?: string } | undefined;
    const reevalLine = reevalPlan?.nextEvalAt
      ? `next eval at ${reevalPlan.nextEvalAt}`
      : 'next eval scheduled per eval:harness-ledger weekly cadence';

    // Kind breakdown table rows
    const kindRows = Object.entries(byKind)
      .map(([k, c]) => `| ${k} | ${c} |`)
      .join('\n');
    const guardRows = Object.entries(byGuard)
      .map(([g, c]) => `| ${g} | ${c} |`)
      .join('\n');

    const verdictMd = [
      '---',
      'feature_ids: [F257]',
      'topics: [harness-eval, eval-harness-ledger, live-verdict]',
      'doc_kind: harness-feedback',
      'feedback_type: live-verdict',
      'domain_id: eval:harness-ledger',
      `packet_id: ${packet.id}`,
      `source_snapshot: "${snapshotRef}"`,
      '---',
      '',
      `# eval:harness-ledger Verdict — ${packet.id}`,
      '',
      `- Verdict: \`${verdictValue}\``,
      `- Phenomenon: ${phenomenon}`,
      `- Harness: ${harnessLine}`,
      `- Owner ask: ${ownerAskLine}`,
      `- Re-eval: ${reevalLine}`,
      '',
      'Evidence:',
      `- ${snapshotRef}`,
      `- ${attributionRef}`,
      '',
      `**Window**: ${windowDays} days | **Events**: ${events.length}`,
      '',
      '## Event Breakdown by Kind',
      '',
      events.length > 0 ? `| Kind | Count |\n|------|-------|\n${kindRows}` : '_No events recorded in this window._',
      '',
      '## Event Breakdown by Guard',
      '',
      events.length > 0 ? `| Guard | Count |\n|-------|-------|\n${guardRows}` : '_No events recorded in this window._',
      '',
      '## Notes',
      '',
      events.length === 0
        ? 'No guard rejection events in this window. The observation layer is active but no guards have triggered rejections yet. This is expected during initial accumulation.'
        : `Observed ${events.length} guard rejection events over ${windowDays} days across ${Object.keys(byKind).length} event kind(s) and ${Object.keys(byGuard).length} guard(s).`,
      '',
    ].join('\n');
    writeFileSync(verdictPath, verdictMd);

    return {
      verdictPath,
      bundleDir,
    };
  };
}
