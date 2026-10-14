import { randomUUID } from 'node:crypto';
import type { MessageMediaPublicationSource } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { HomeActionRequest, HomeActionResult } from '../../../action/HomeActionController.js';
import { ownerLiteralValues } from '../../../action/jev/JevPageSelector.js';
import type { PageChoice } from '../../../action/PageActionLoop.js';
import {
  type HomeOwnedTarget,
  homeComposerLiteralValues,
  homeHubStateSchema,
  homeHubTargets,
} from './home-hub-targets.js';
import { appendHomeOwnerDraft } from './home-owner-draft.js';
import { HomeWindowCapabilities } from './home-window-capabilities.js';

export interface HomeHubEmitter {
  isConnected?(ownerUserId: string, socketId: string): boolean;
  emitWithAck(
    ownerUserId: string,
    event: string,
    data: unknown,
    timeoutMs: number,
    socketIds?: readonly string[],
  ): Promise<unknown[]>;
  emit(ownerUserId: string, event: string, data: unknown, socketIds?: readonly string[]): void;
}
type Outcome = Pick<HomeActionResult, 'status' | 'reason'>;
interface Command {
  ownerUserId: string;
  clientId: string;
  signal: AbortSignal;
  expiresAt: number;
  authorize(expectedRevision?: number): Promise<unknown>;
  consumed?: Promise<unknown>;
}

export interface HomeWorkPublication {
  source: MessageMediaPublicationSource;
  artifact?: { contentRef: string; ownerRevision: number };
}

function validHomeChoice(
  request: HomeActionRequest,
  target: HomeOwnedTarget,
  choice: Extract<PageChoice, { kind: 'act' }>,
): boolean {
  const standard = ownerLiteralValues(request.text);
  const values = standard.length ? standard : homeComposerLiteralValues(request.text);
  return (
    choice.targetId === target.id &&
    choice.operation === target.operation &&
    (choice.operation !== 'fill' || Boolean(choice.value && values.includes(choice.value)))
  );
}

/** Short-lived delivery capabilities only; thread, draft and persistent result owners remain authoritative. */
export class HomeHubDelivery {
  private readonly commands = new Map<string, Command>();
  private readonly clients: HomeWindowCapabilities;
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'getOwnerComposerDraft' | 'putOwnerComposerDraft'>;
      threads: Pick<IThreadStore, 'list'>;
      emitter: HomeHubEmitter;
      isCurrent(request: HomeActionRequest): Promise<boolean>;
    },
  ) {
    this.clients = new HomeWindowCapabilities(deps.emitter.isConnected);
  }

  registerClient(ownerUserId: string, clientId: string, socketId?: string) {
    return this.clients.register(ownerUserId, clientId, socketId);
  }

  unregisterClient(ownerUserId: string, clientId: string, clientToken: string): boolean {
    return this.clients.unregister(ownerUserId, clientId, clientToken);
  }

  private async windows(ownerUserId: string) {
    const values = await this.deps.emitter.emitWithAck(
      ownerUserId,
      'home:inspect',
      {},
      1_500,
      this.clients.connections(ownerUserId),
    );
    const states = values.flatMap((value) => {
      const parsed = homeHubStateSchema.safeParse(value);
      return parsed.success && this.clients.owns(ownerUserId, parsed.data.clientId, parsed.data.clientToken)
        ? [parsed.data]
        : [];
    });
    return states;
  }

  async targets(request: HomeActionRequest): Promise<HomeOwnedTarget[]> {
    const states = await this.windows(request.userId);
    // Two foreground consumers are ambiguous; never fan an operation out to both.
    if (states.length !== 1 || request.signal.aborted) return [];
    return homeHubTargets(states[0], await this.deps.threads.list(request.userId), request.text);
  }

  async execute(
    request: HomeActionRequest,
    target: HomeOwnedTarget,
    choice: Extract<PageChoice, { kind: 'act' }>,
  ): Promise<Outcome> {
    if (!validHomeChoice(request, target, choice)) return { status: 'blocked', reason: 'choice_not_from_owner' };
    for (const [token, command] of this.commands) if (command.expiresAt <= Date.now()) this.commands.delete(token);
    if (this.commands.size >= 64 || request.signal.aborted || !(await this.deps.isCurrent(request)))
      return { status: 'stale', reason: 'home_source_unavailable' };
    const expiresAt = Date.now() + 10_000;
    const command: Command = {
      ownerUserId: request.userId,
      clientId: target.clientId,
      signal: request.signal,
      expiresAt,
      authorize: (revision) => this.authorize(request, target, choice, expiresAt, revision),
    };
    return this.deliver(command);
  }

  /** The work owner revalidates the exact source on consume; this port owns delivery only. */
  async openWork(
    ownerUserId: string,
    resolve: () => Promise<HomeWorkPublication | null>,
    assertCurrent: () => Promise<void>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<'applied' | 'blocked' | 'unconfirmed'> {
    await assertCurrent();
    const states = await this.windows(ownerUserId);
    await assertCurrent();
    if (signal.aborted) return 'blocked';
    if (states.length !== 1) return 'unconfirmed';
    const [state] = states;
    let publication: HomeWorkPublication | null = null;
    const expiresAt = Date.now() + 10_000;
    const command: Command = {
      ownerUserId,
      clientId: state.clientId,
      signal,
      expiresAt,
      authorize: async () => {
        try {
          await assertCurrent();
          const windows = await this.windows(ownerUserId);
          if (windows.length !== 1 || windows[0].clientId !== state.clientId || windows[0].route !== state.route)
            return { kind: 'blocked' };
          publication = await resolve();
          await assertCurrent();
          if (!publication || signal.aborted || Date.now() >= expiresAt) return { kind: 'blocked' };
          return {
            kind: 'navigate',
            clientId: state.clientId,
            baseRoute: state.route,
            expiresAt,
            action: { kind: 'publication', ...publication },
          };
        } catch {
          return { kind: 'blocked' };
        }
      },
    };
    const result = await this.deliver(command, (receipt) => {
      const shown = receipt.artifact as HomeWorkPublication['artifact'];
      return Boolean(
        publication?.artifact &&
          shown &&
          shown.contentRef === publication.artifact.contentRef &&
          shown.ownerRevision === publication.artifact.ownerRevision,
      );
    });
    if (signal.aborted) return 'blocked';
    try {
      await assertCurrent();
    } catch {
      return 'blocked';
    }
    return result.status === 'applied' || result.status === 'blocked' ? result.status : 'unconfirmed';
  }

  private async deliver(
    command: Command,
    verifyApplied?: (receipt: Record<string, unknown>) => boolean,
  ): Promise<Outcome> {
    for (const [token, pending] of this.commands) if (pending.expiresAt <= Date.now()) this.commands.delete(token);
    if (this.commands.size >= 64) return { status: 'unconfirmed', reason: 'hub_delivery_capacity' };
    const token = randomUUID();
    this.commands.set(token, command);
    const cancel = () =>
      this.deps.emitter.emit(
        command.ownerUserId,
        'home:cancel',
        { token, clientId: command.clientId },
        this.clients.connections(command.ownerUserId, command.clientId),
      );
    command.signal.addEventListener('abort', cancel, { once: true });
    try {
      const values = await this.deps.emitter.emitWithAck(
        command.ownerUserId,
        'home:execute',
        { token, clientId: command.clientId, expiresAt: command.expiresAt },
        8_000,
        this.clients.connections(command.ownerUserId, command.clientId),
      );
      const receipt = values.find((value): value is Record<string, unknown> & { status: string; reason?: string } => {
        if (!value || typeof value !== 'object') return false;
        const v = value as Record<string, unknown>;
        return (
          v.token === token &&
          v.clientId === command.clientId &&
          typeof v.clientToken === 'string' &&
          this.clients.owns(command.ownerUserId, command.clientId, v.clientToken) &&
          typeof v.status === 'string'
        );
      });
      if (!receipt || !command.consumed) return { status: 'unconfirmed', reason: 'no_matching_hub_receipt' };
      if (command.signal.aborted || command.expiresAt <= Date.now())
        return { status: 'unconfirmed', reason: 'hub_request_expired' };
      return this.confirmOutcome(command, await command.consumed, receipt, verifyApplied);
    } finally {
      cancel();
      this.commands.delete(token);
      command.signal.removeEventListener('abort', cancel);
    }
  }

  private confirmOutcome(
    command: Command,
    grant: unknown,
    receipt: Record<string, unknown> & { status: string; reason?: string },
    verifyApplied?: (receipt: Record<string, unknown>) => boolean,
  ): Outcome {
    // The commit may finish after the earlier transport check; a cancelled display cannot become applied.
    if (
      command.signal.aborted ||
      command.expiresAt <= Date.now() ||
      !this.clients.owns(command.ownerUserId, command.clientId, String(receipt.clientToken))
    )
      return { status: 'unconfirmed', reason: 'hub_view_changed_during_commit' };
    if (
      !grant ||
      typeof grant !== 'object' ||
      !('kind' in grant) ||
      !['navigate', 'updated'].includes(String(grant.kind))
    )
      return { status: 'blocked', reason: 'owner_action_not_authorized' };
    if (grant.kind === 'updated' && receipt.status !== 'applied')
      return { status: 'unconfirmed', reason: 'draft_committed_display_unconfirmed' };
    if (!['applied', 'blocked', 'unconfirmed'].includes(receipt.status)) return { status: 'unconfirmed' };
    if (receipt.status === 'applied' && verifyApplied && !verifyApplied(receipt))
      return { status: 'unconfirmed', reason: 'publication_display_not_confirmed' };
    return {
      status: receipt.status as Outcome['status'],
      ...(receipt.reason ? { reason: receipt.reason.slice(0, 160) } : {}),
    };
  }

  consume(
    ownerUserId: string,
    token: string,
    clientId: string,
    clientToken: string,
    expectedRevision?: number,
  ): Promise<unknown> {
    const command = this.commands.get(token);
    if (
      !this.clients.owns(ownerUserId, clientId, clientToken) ||
      !command ||
      command.ownerUserId !== ownerUserId ||
      command.clientId !== clientId
    )
      return Promise.resolve({ kind: 'blocked' });
    // Browser/network duplicate consumes do not repeat a CAS or authorize a second navigation.
    if (command.consumed) return Promise.resolve({ kind: 'blocked', reason: 'already_consumed' });
    command.consumed = command.authorize(expectedRevision).then((grant) =>
      // Revocation fences future effects; it cannot undo a CAS the draft owner already committed.
      (grant && typeof grant === 'object' && 'kind' in grant && grant.kind === 'updated') ||
      (this.commands.get(token) === command &&
        this.clients.owns(ownerUserId, clientId, clientToken) &&
        !command.signal.aborted &&
        command.expiresAt > Date.now())
        ? grant
        : { kind: 'blocked' },
    );
    return command.consumed;
  }

  close(): void {
    for (const [token, command] of this.commands)
      this.deps.emitter.emit(
        command.ownerUserId,
        'home:cancel',
        { token, clientId: command.clientId },
        this.clients.connections(command.ownerUserId, command.clientId),
      );
    this.commands.clear();
    this.clients.clear();
  }

  private async authorize(
    request: HomeActionRequest,
    original: HomeOwnedTarget,
    choice: Extract<PageChoice, { kind: 'act' }>,
    expiresAt: number,
    expectedRevision?: number,
  ) {
    const currentTargets = await this.targets(request);
    const target = currentTargets.find(
      (candidate) => candidate.id === original.id && candidate.revision === original.revision,
    );
    if (!target) return { kind: 'stale' };
    if (Date.now() >= expiresAt || request.signal.aborted || !(await this.deps.isCurrent(request)))
      return { kind: 'stale' };
    const common = { clientId: target.clientId, baseRoute: target.route, expiresAt };
    if (target.ownerAction.kind !== 'draft') return { kind: 'navigate', ...common, action: target.ownerAction };
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision === undefined ||
      expectedRevision < 0 ||
      choice.operation !== 'fill' ||
      !choice.value
    )
      return { kind: 'blocked' };
    const result = await appendHomeOwnerDraft({
      ...this.deps,
      ownerUserId: request.userId,
      threadId: target.ownerAction.threadId,
      expectedRevision,
      literal: choice.value,
      isCurrent: () => this.deps.isCurrent(request),
      signal: request.signal,
    });
    return result.kind === 'updated' ? { ...result, ...common } : result;
  }
}
