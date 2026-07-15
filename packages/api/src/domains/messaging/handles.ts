/**
 * Plugin Messaging — host-issued address handles (K-1 / F258, AC-2, §4c)
 *
 * Handles are the ONLY addressing channel for drafts — schema-level there is
 * no bare-threadId path (§3.1). A handle binds pluginInstance + grant scope +
 * thread at issuance; the scope is the grant projection (K-2 control plane
 * takes over the issuance entry point; the mechanics live here).
 *
 * Lifecycle owner for HandleRecord state (§4c): this service. Revocation
 * cascades to subscriptions via CursorStore.revokeByHandle.
 */

import { randomUUID } from 'node:crypto';
import type { HandleScope, MessageAddress } from './contract/types.js';
import { MessagingError } from './contract/types.js';
import type { CursorStore, HandleRecord, HandleStore } from './stores/ports.js';

export interface IssueThreadHandleInput {
  readonly pluginInstanceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly scope: HandleScope;
}

export interface IssueConnectorBindingHandleInput extends IssueThreadHandleInput {
  readonly connectorId: string;
  readonly externalChatId: string;
}

export class HandleService {
  private readonly handles: HandleStore;
  private readonly cursors: CursorStore;

  constructor(handles: HandleStore, cursors: CursorStore) {
    this.handles = handles;
    this.cursors = cursors;
  }

  async issueThreadHandle(input: IssueThreadHandleInput): Promise<{ handleId: string }> {
    const record: HandleRecord = {
      handleId: `th_${randomUUID()}`,
      kind: 'thread_handle',
      pluginInstanceId: input.pluginInstanceId,
      threadId: input.threadId,
      userId: input.userId,
      scope: input.scope,
      issuedAt: Date.now(),
    };
    await this.handles.put(record);
    return { handleId: record.handleId };
  }

  async issueConnectorBindingHandle(input: IssueConnectorBindingHandleInput): Promise<{ handleId: string }> {
    const record: HandleRecord = {
      handleId: `cb_${randomUUID()}`,
      kind: 'connector_binding',
      pluginInstanceId: input.pluginInstanceId,
      threadId: input.threadId,
      userId: input.userId,
      scope: input.scope,
      connectorBinding: { connectorId: input.connectorId, externalChatId: input.externalChatId },
      issuedAt: Date.now(),
    };
    await this.handles.put(record);
    return { handleId: record.handleId };
  }

  /** Common gate: existence → instance binding (INV-8) → liveness. */
  private async resolveLive(pluginInstanceId: string, handleId: string): Promise<HandleRecord> {
    const record = await this.handles.get(handleId);
    if (!record) throw new MessagingError('NOT_FOUND', `unknown handle ${handleId}`);
    if (record.pluginInstanceId !== pluginInstanceId) {
      throw new MessagingError('PERMISSION', 'handle is not bound to the calling plugin instance (INV-8)');
    }
    if (record.revokedAt !== undefined) {
      throw new MessagingError('PERMISSION', 'handle has been revoked (INV-8)');
    }
    return record;
  }

  async resolveForSend(pluginInstanceId: string, address: MessageAddress): Promise<HandleRecord> {
    const record = await this.resolveLive(pluginInstanceId, address.handle);
    if (record.kind !== address.kind) {
      throw new MessagingError('VALIDATION', `address kind ${address.kind} does not match handle kind ${record.kind}`);
    }
    if (!record.scope.canSend) {
      throw new MessagingError('PERMISSION', 'handle scope does not grant send');
    }
    return record;
  }

  async resolveForSubscribe(pluginInstanceId: string, handleId: string): Promise<HandleRecord> {
    const record = await this.resolveLive(pluginInstanceId, handleId);
    if (!record.scope.canSubscribe) {
      throw new MessagingError('PERMISSION', 'handle scope does not grant subscribe');
    }
    return record;
  }

  /** active → revoked (idempotent); cascades to subscriptions (§4c). */
  async revoke(handleId: string): Promise<void> {
    const revokedAt = Date.now();
    await this.handles.revoke(handleId, revokedAt);
    await this.cursors.revokeByHandle(handleId, revokedAt);
  }
}
