import type { OutputMessageIdentity } from './output-message.js';

export interface MessageOutputOwner {
  threadId: string;
  catId: string;
  /** The visible child turn, never its shared chain/parent invocation. */
  turnInvocationId: string;
}

export interface MessageContentRevision {
  /** UTF-16 code units of the normalized, actually published content. */
  length: number;
  /** SHA-256 of that same content encoded as UTF-8. */
  sha256: string;
}

/** A closed host producer observation, never a native output identity/channel. */
export interface HostSignatureOutput {
  v: 1;
  kind: 'cat_signature';
  producer: 'codex_stream_finalizer';
  role: 'answer_suffix';
  basis: 'runtime_canonical' | 'provider_observed_fallback';
}
export interface MessageOutputHostTail {
  kind: HostSignatureOutput['kind'];
  producer: HostSignatureOutput['producer'];
  basis: HostSignatureOutput['basis'];
  start: number;
  end: number;
  gluePrefixLength: 2;
}

export interface MessageOutputRun {
  id: string;
  identity: OutputMessageIdentity;
  channel: 'commentary' | 'final';
  complete: true;
  /** Half-open UTF-16 range in the message's one canonical content string. */
  start: number;
  end: number;
  /** Explicit aggregation newline glue at the beginning of this range. */
  gluePrefixLength: 0 | 1 | 2;
}

export type MessageOutputOrderRef =
  | { kind: 'run'; runId: string }
  | { kind: 'tool'; toolEventId: string; executionRef: string };

export type MessageOutputUnavailableReason =
  | 'unknown_output'
  | 'incomplete'
  | 'no_final'
  | 'conflict'
  | 'oversized'
  | 'content_changed'
  | 'callback'
  | 'whole_body_replaced';

/** Optional references only: never a second body or copy of the tool events. */
export type MessageOutputLayoutV1 = {
  v: 1;
  owner: MessageOutputOwner;
  contentRevision: MessageContentRevision;
} & (
  | {
      status: 'available';
      runs: readonly MessageOutputRun[];
      order: readonly MessageOutputOrderRef[];
      hostTail?: MessageOutputHostTail;
    }
  | { status: 'unavailable'; reason: MessageOutputUnavailableReason }
);

export const MAX_MESSAGE_OUTPUT_RUNS = 128;
export const MAX_MESSAGE_OUTPUT_REFS = 512;
