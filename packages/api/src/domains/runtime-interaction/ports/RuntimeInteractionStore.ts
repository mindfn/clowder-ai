import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';

export interface CreateRuntimeInteractionInput {
  request: RuntimeInteractionRequest;
  hostEpoch: string;
  now: number;
}

export interface SettleRuntimeInteractionInput {
  interactionId: string;
  hostEpoch: string;
  terminal: RuntimeInteractionTerminal;
  now: number;
}

export interface InvalidateRuntimeInteractionInput {
  interactionId: string;
  reasonCode: RuntimeInteractionTerminalReasonCode;
  now: number;
}

/** One pending-index snapshot. Partial means at least one indexed detail could not be read or verified. */
export interface RuntimeInteractionPendingIndexRead {
  records: RuntimeInteractionRecord[];
  exhaustiveness: 'complete' | 'partial';
}

export interface RuntimeInteractionStore {
  createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord>;
  anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
  ): Promise<RuntimeInteractionRecord | null>;
  settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  get(interactionId: string): Promise<RuntimeInteractionRecord | null>;
  readPendingIndexByUser(userId: string): Promise<RuntimeInteractionPendingIndexRead>;
  listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]>;
}

/** Legacy list-only sources can expose known rows, but cannot prove that their pending index was read exhaustively. */
export type RuntimeInteractionPendingReadSource = Pick<RuntimeInteractionStore, 'listPendingByUser'> &
  Partial<Pick<RuntimeInteractionStore, 'readPendingIndexByUser'>>;
