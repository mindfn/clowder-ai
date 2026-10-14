import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId, type RequestGenerationRetryReason } from '@cat-cafe/shared';
import { ScopedSessionOwner } from '../src/domains/cats/services/agents/invocation/collective-scoped-session-owner.js';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import type { PreparedProviderRequestV1 } from '../src/domains/cats/services/types.js';

for (const reason of [undefined, 'provider_fallback', 'provider_busy'] as const) {
  test(`scoped repeated provider launch records ${reason ?? 'provider_continuation'} and its terminal outcome`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'f290-generation-boundary-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sessions = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: directory });
    const catId = createCatId('codex-sol');
    const owner = await ScopedSessionOwner.open({
      sessions,
      transcript: writer,
      sealer: new SessionSealer(sessions, writer),
      catId,
      userId: 'owner',
      threadId: 'thread',
      scope: { invocationId: 'child', executionScope: 'collective-participation', originMessageId: 'source' },
      startedAt: Date.now(),
      signal: new AbortController().signal,
    });
    const prepared = (boundaryReason?: RequestGenerationRetryReason): PreparedProviderRequestV1 => ({
      v: 1,
      message: { body: 'PUBLIC_ONLY' },
      nativeInstructions: [],
      runtime: { provider: 'openai', carrier: 'scripted-test', model: 'fixture-model' },
      providerNativeVisibility: 'unsupported',
      tools: { finalSurface: 'unknown' },
      ...(boundaryReason ? { boundaryReason } : {}),
    });
    const first = await owner.beforeProviderLaunch(prepared());
    await owner.recordProviderMessage({
      type: 'session_init',
      catId,
      sessionId: 'actual-scripted-native',
      timestamp: Date.now(),
    });
    const second = await owner.beforeProviderLaunch(prepared(reason));
    assert.equal(second.generationOrdinal, 2);
    assert.equal(first.sessionId, second.sessionId);
    await owner.recordProviderMessage({ type: 'text', catId, content: 'ACTUAL_SECOND_OUTPUT', timestamp: Date.now() });
    await owner.complete(false);
    const record = sessions.get(first.sessionId)!;
    assert.equal(record.status, 'sealed');
    const events = await new TranscriptReader({ dataDir: directory }).readAllEvents(record.id, 'thread', catId);
    const assembled = events.filter((event) => event.event.type === 'request_generation_assembled');
    const envelope = assembled[1]!.event.envelope as { retryBoundary: { reason: string; attempt: number } };
    assert.equal(envelope.retryBoundary.reason, reason ?? 'provider_continuation');
    assert.equal(envelope.retryBoundary.attempt, 1, 'both launches belong to the same invoke attempt');
    const terminals = events.filter((event) => event.event.type === 'request_generation_terminal');
    assert.equal(terminals[0]!.event.reason, reason ?? 'provider_continuation');
    assert.equal(
      terminals[0]!.event.outcome,
      reason === 'provider_busy' ? 'rejected' : reason ? 'replaced' : 'accepted',
    );
    assert.equal(terminals[1]!.event.outcome, 'accepted');
  });
}
