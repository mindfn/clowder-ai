import type { CatId, SessionRecord } from '@cat-cafe/shared';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { TranscriptWriter } from '../../session/TranscriptWriter.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { AgentMessage, AgentServiceOptions, ProviderRequestGenerationCommitV1 } from '../../types.js';
import { createRequestGenerationRecorder } from './request-generation-recorder.js';

export interface ScopedSessionInput {
  readonly sessions?: ISessionChainStore;
  readonly transcript?: TranscriptWriter;
  readonly sealer?: ISessionSealer;
  readonly catId: CatId;
  readonly userId: string;
  readonly threadId: string;
  readonly scope: NonNullable<SessionRecord['scopedInvocation']>;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

/** Owns exactly one trace node; no operation resolves or replaces the home active record. */
export class ScopedSessionOwner {
  private commit?: ProviderRequestGenerationCommitV1;
  private sealAttempted = false;
  private readonly recorder: ReturnType<typeof createRequestGenerationRecorder>;
  private constructor(
    readonly input: ScopedSessionInput,
    private record: SessionRecord,
    private readonly sessions: ISessionChainStore,
    private readonly transcript: TranscriptWriter,
    private readonly sealer: ISessionSealer,
  ) {
    this.recorder = createRequestGenerationRecorder({
      invocationId: input.scope.invocationId,
      threadId: input.threadId,
      userId: input.userId,
      catId: input.catId,
      transcriptWriter: transcript,
      sessionChainStore: sessions,
      resolveSession: () => this.record,
      snapshot: () => ({
        continuity: { capability: 'unknown', compactionRefs: [] },
        presentations: [],
        messageSourceRefs: [{ owner: 'message', ref: `${input.threadId}:${input.scope.originMessageId}` }],
        nativeInstructionSourceRefs: [{ owner: 'system_prompt', ref: `collective:${input.scope.executionScope}` }],
      }),
    });
  }
  static async open(input: ScopedSessionInput) {
    const { sessions, transcript, sealer } = input;
    if (!sessions || !transcript || !sealer) throw new Error('collective_session_owner_unavailable');
    const record = await sessions.create({
      catId: input.catId,
      userId: input.userId,
      threadId: input.threadId,
      scopedInvocation: input.scope,
      compressionCount: null,
    });
    return new ScopedSessionOwner(input, record, sessions, transcript, sealer);
  }
  private info() {
    return {
      sessionId: this.record.id,
      threadId: this.record.threadId,
      catId: this.record.catId,
      seq: this.record.seq,
      ...(this.record.cliSessionId ? { cliSessionId: this.record.cliSessionId } : {}),
    };
  }
  append(message: AgentMessage) {
    return this.transcript.appendDurableEvent(
      this.info(),
      message as unknown as Record<string, unknown>,
      this.input.scope.invocationId,
    );
  }
  metrics(kind: 'session_started' | 'invocation_complete'): AgentMessage {
    return {
      type: 'system_info',
      catId: this.input.catId,
      timestamp: Date.now(),
      content: JSON.stringify({
        type: 'invocation_metrics',
        kind,
        invocationId: this.input.scope.invocationId,
        ...(this.record.cliSessionId ? { sessionId: this.record.cliSessionId } : {}),
        sessionSeq: this.record.seq + 1,
        ...(kind === 'invocation_complete' ? { durationMs: Date.now() - this.input.startedAt } : {}),
      }),
    };
  }
  readonly beforeProviderLaunch: NonNullable<AgentServiceOptions['beforeProviderLaunch']> = async (prepared) => {
    this.input.signal.throwIfAborted();
    const reason = prepared.boundaryReason ?? (this.commit ? 'provider_continuation' : undefined);
    if (this.commit) {
      const outcome =
        reason === 'provider_continuation' ? 'accepted' : reason === 'provider_busy' ? 'rejected' : 'replaced';
      await this.recorder.recordTerminal(this.commit, outcome, reason);
    }
    this.commit = await this.recorder.recordPrepared(prepared, { attempt: 1, ...(reason ? { reason } : {}) });
    return this.commit;
  };
  async recordProviderMessage(message: AgentMessage) {
    this.input.signal.throwIfAborted();
    if (this.commit)
      await this.recorder.recordObserved(this.commit, {
        evidenceRef: `provider_event:${this.input.scope.invocationId}:${message.type}:${message.timestamp}`,
        ...(message.sessionId ? { runtimeSessionId: message.sessionId } : {}),
      });
    if (message.type === 'session_init' && message.sessionId) await this.bindRuntime(message.sessionId);
    await this.append(message);
  }
  private async bindRuntime(nativeId: string) {
    if (this.record.cliSessionId === nativeId) return;
    if (this.record.cliSessionId) throw new Error('collective_session_runtime_identity_changed');
    const bound = await this.sessions.bindCliSessionIdIfUnbound(this.record.id, nativeId);
    if (!bound) throw new Error('collective_session_runtime_binding_conflict');
    this.record = bound;
  }
  async complete(failed: boolean) {
    this.input.signal.throwIfAborted();
    if (!this.record.cliSessionId) throw new Error('collective_session_runtime_identity_unproved');
    if (this.commit) await this.recorder.recordTerminal(this.commit, failed ? 'error' : 'accepted');
    await this.sessions.update(this.record.id, { messageCount: 1, updatedAt: Date.now() });
    const completed = this.metrics('invocation_complete');
    await this.append(completed);
    await this.seal(failed ? 'scoped_error' : 'scoped_complete');
    return completed;
  }
  async fail(cause: unknown) {
    if (this.commit)
      await this.recorder
        .recordTerminal(this.commit, this.input.signal.aborted ? 'cancelled' : 'error', 'scoped_execution_failed')
        .catch(() => undefined);
    await this.append({
      type: 'error',
      catId: this.input.catId,
      timestamp: Date.now(),
      error: cause instanceof Error ? cause.message : 'collective_scoped_execution_failed',
    }).catch(() => undefined);
  }
  async close(caught: boolean, hasTerminal: boolean) {
    if (this.sealAttempted) return;
    const canceled = this.input.signal.aborted || (!hasTerminal && !caught);
    if (canceled)
      await this.append({
        type: 'error',
        catId: this.input.catId,
        timestamp: Date.now(),
        error: 'collective_scoped_execution_interrupted',
      }).catch(() => undefined);
    try {
      await this.seal(canceled ? 'scoped_cancel' : 'scoped_error');
    } catch (error) {
      if (!caught) throw error;
    }
  }
  private async seal(reason: string) {
    this.sealAttempted = true;
    const requested = await this.sealer.requestSeal({ sessionId: this.record.id, reason });
    if (!requested.accepted) throw new Error('collective_session_seal_not_accepted');
    const finalized = await this.sealer.finalize({ sessionId: this.record.id });
    if (!finalized.sealed || !finalized.clean || (await this.sessions.get(this.record.id))?.status !== 'sealed')
      throw new Error('collective_session_finalize_incomplete');
  }
}
