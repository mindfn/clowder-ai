import type { AgentKeyFailureReason } from './agent-key-reasons.js';
import type { CatId } from './ids.js';

export interface AgentKeyRecord {
  agentKeyId: string;
  catId: CatId;
  userId: string;
  secretHash: string;
  salt: string;
  scope: 'user-bound';
  issuedAt: number;
  /** null is an explicitly provisioned revocation-bound service credential; default keys still expire. */
  expiresAt: number | null;
  rotatedFrom?: string;
  graceUntil?: number;
  lastUsedAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type AgentKeyVerifyResult = { ok: true; record: AgentKeyRecord } | { ok: false; reason: AgentKeyFailureReason };
