import type {
  CycleEvaluationSubmission,
  CycleRecord,
  CycleTracePage,
  TraceAnnotation,
  TraceEpisode,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { isHighConfidenceCounterexample } from '../trace-annotation/high-confidence-annotation.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

/** Reads the immutable trace pool and validates evidence-bound cycle writeback. */
export class CycleEvaluationEvidence {
  constructor(
    private readonly runtime: ObjectiveEvaluationRuntime,
    private readonly messageStore: Pick<IMessageStore, 'getByIds'>,
  ) {}

  async read(record: CycleRecord, input: { cursor: number; limit: number }): Promise<CycleTracePage> {
    const priority = await this.counterexampleMap(record);
    const invocationIds = await this.runtime.traces.ownerInvocationIds(record.ownerUserId, record.windows);
    const available = new Set(invocationIds);
    const ordered = [
      ...[...priority.keys()].filter((invocationId) => available.has(invocationId)),
      ...invocationIds.filter((invocationId) => !priority.has(invocationId)),
    ];
    if (input.cursor > ordered.length) throw new Error(`cycle_trace_cursor_out_of_range:${input.cursor}`);
    const selected = ordered.slice(input.cursor, input.cursor + input.limit);
    const episodes = (
      await Promise.all(selected.map((invocationId) => this.runtime.traces.getEpisodeByInvocationId(invocationId)))
    ).filter((episode): episode is TraceEpisode => episode !== null);
    const messages = await this.loadMessages(record.ownerUserId, episodes);
    const projected = episodes.map((episode) => this.projectEpisode(episode, priority, messages, record.objectiveId));
    const next = input.cursor + selected.length;
    return {
      objectiveId: record.objectiveId,
      cycleId: record.cycleId,
      cursor: input.cursor,
      ...(next < ordered.length ? { nextCursor: next } : {}),
      total: ordered.length,
      episodes: projected,
    };
  }

  async validateSubmission(record: CycleRecord, input: CycleEvaluationSubmission): Promise<void> {
    const objective = this.runtime.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
    const model = this.runtime.catalog.registry.evaluationModels.find(
      (item) => item.id === objective?.evaluationModelId,
    );
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
    const submitted = new Map(input.metrics.map((metric) => [metric.id, metric]));
    if (submitted.size !== input.metrics.length || submitted.size !== model.metrics.length) {
      throw new Error(`cycle_evaluation_metric_coverage:${record.cycleId}`);
    }
    const evidenceRefs = new Set<string>();
    let evidenceRefCount = 0;
    for (const definition of model.metrics) {
      const metric = submitted.get(definition.id);
      if (!metric || metric.conclusion.kind !== conclusionKind(definition.kind)) {
        throw new Error(`cycle_evaluation_metric_conclusion:${definition.id}`);
      }
      validateConclusion(metric.conclusion);
      evidenceRefCount += metric.evidenceRefs.length;
      for (const ref of metric.evidenceRefs) evidenceRefs.add(ref);
    }
    if (evidenceRefCount > 64) throw new Error(`cycle_evaluation_evidence_limit:${record.cycleId}`);
    await Promise.all([...evidenceRefs].map((ref) => this.validateEvidenceRef(record, ref)));
  }

  private async counterexampleMap(record: CycleRecord): Promise<Map<string, string[]>> {
    const objective = this.runtime.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
    const model = this.runtime.catalog.registry.evaluationModels.find(
      (item) => item.id === objective?.evaluationModelId,
    );
    if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
    const lists = await Promise.all(
      record.windows.flatMap((window) =>
        model.metrics.map((metric) =>
          this.runtime.annotations.queryMetricWindow(
            record.ownerUserId,
            record.objectiveId,
            metric.id,
            window.start,
            window.end,
          ),
        ),
      ),
    );
    const annotations = lists
      .flat()
      .filter((annotation: TraceAnnotation) => isHighConfidenceCounterexample(annotation))
      .sort((left, right) => left.createdAt - right.createdAt || left.incidentKey.localeCompare(right.incidentKey));
    const byInvocation = new Map<string, string[]>();
    for (const annotation of annotations) {
      const invocationId = annotation.episodeRef.invocationId;
      const keys = byInvocation.get(invocationId) ?? [];
      if (!keys.includes(annotation.incidentKey)) keys.push(annotation.incidentKey);
      byInvocation.set(invocationId, keys);
    }
    return byInvocation;
  }

  private async loadMessages(ownerUserId: string, episodes: TraceEpisode[]): Promise<Map<string, StoredMessage>> {
    const ids = episodes.flatMap((episode) =>
      [episode.terminal.inputMessageId, episode.terminal.outputMessageId].filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    const messages = ids.length > 0 ? await this.messageStore.getByIds([...new Set(ids)]) : [];
    return new Map(
      messages
        .filter((message) => message.userId === ownerUserId && !message.deletedAt)
        .map((message) => [message.id, message]),
    );
  }

  private projectEpisode(
    episode: TraceEpisode,
    priority: Map<string, string[]>,
    messages: Map<string, StoredMessage>,
    objectiveId: string,
  ): CycleTracePage['episodes'][number] {
    const unitIds = new Set(
      this.runtime.catalog.manifest.units
        .filter((unit) => unit.objectives.some((objective) => objective.objectiveId === objectiveId))
        .map((unit) => unit.unitId),
    );
    const message = (id: string | null) => {
      const stored = id ? messages.get(id) : undefined;
      if (!stored || stored.threadId !== episode.terminal.threadId) return null;
      return { messageId: stored.id, text: truncate(stored.content, 2_000) };
    };
    const calls = episode.terminal.toolCalls.map(({ toolName, outcome }) => ({ toolName, outcome }));
    const incidentKeys = priority.get(episode.terminal.invocationId);
    return {
      invocationId: episode.terminal.invocationId,
      terminalAt: episode.terminal.terminalAt,
      threadId: episode.terminal.threadId,
      catId: episode.terminal.catId,
      terminalKind: episode.terminal.terminalKind,
      priority: incidentKeys ? 'counterexample' : 'ordinary',
      ...(incidentKeys ? { incidentKeys } : {}),
      segments: episode.summary.segments
        .filter((segment) => unitIds.has(segment.segmentId))
        .map((segment) => ({
          segmentId: segment.segmentId,
          status: segment.status,
          ...(segment.pipelineStatus ? { pipelineStatus: segment.pipelineStatus } : {}),
          ...(segment.reasonCode ? { reasonCode: segment.reasonCode } : {}),
        })),
      input: message(episode.terminal.inputMessageId),
      output: message(episode.terminal.outputMessageId),
      toolCalls: {
        total: calls.length,
        head: calls.slice(0, 5),
        tail: calls.slice(Math.max(5, calls.length - 5)),
      },
    };
  }

  private async validateEvidenceRef(record: CycleRecord, invocationId: string): Promise<void> {
    const episode = await this.runtime.traces.getEpisodeByInvocationId(invocationId);
    const inWindow =
      episode &&
      record.windows.some(
        (window) => episode.terminal.terminalAt >= window.start && episode.terminal.terminalAt < window.end,
      );
    if (!episode || episode.terminal.ownerUserId !== record.ownerUserId || !inWindow) {
      throw new Error(`cycle_evaluation_invalid_evidence_ref:${invocationId}`);
    }
  }
}

function conclusionKind(kind: string): 'count' | 'rate-badness' | 'semantic-label' {
  if (kind === 'rate') return 'rate-badness';
  if (kind === 'semantic') return 'semantic-label';
  return 'count';
}

function validateConclusion(conclusion: CycleEvaluationSubmission['metrics'][number]['conclusion']): void {
  if (conclusion.kind === 'rate-badness' && (conclusion.value < 0 || conclusion.value > 1)) {
    throw new Error('cycle_evaluation_rate_out_of_range');
  }
  const value = conclusion.kind === 'semantic-label' ? conclusion.count : conclusion.value;
  if (!Number.isFinite(value) || value < 0) throw new Error('cycle_evaluation_value_invalid');
  if (conclusion.kind !== 'rate-badness' && !Number.isSafeInteger(value)) {
    throw new Error('cycle_evaluation_value_invalid');
  }
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
