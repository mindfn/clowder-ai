import { type CloudBridgeOutboundReceiptV1, createCatId, isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../../stores/visibility.js';
import type { PersistenceContext } from './route-helpers.js';

const log = createModuleLogger('route-system-info-persistence');

function projectOutboundReceipt(value: unknown): CloudBridgeOutboundReceiptV1 | undefined {
  if (!isCloudBridgeOutboundReceiptV1(value)) return undefined;
  return {
    v: 1,
    sourceMessageId: value.sourceMessageId,
    sourceSender: {
      kind: value.sourceSender.kind,
      id: value.sourceSender.id,
      ...(value.sourceSender.invocationId ? { invocationId: value.sourceSender.invocationId } : {}),
    },
    dispatchInvocationId: value.dispatchInvocationId,
    targetCatId: value.targetCatId,
    status: value.status,
    transport: value.transport,
    ...(value.hostMessageId ? { hostMessageId: value.hostMessageId } : {}),
    ...(value.failure ? { failure: value.failure } : {}),
    idempotency: {
      keyKind: 'source_message_id',
      disposition: value.idempotency.disposition,
    },
  };
}

function parseVisibleNotice(
  content: string,
  catId: string,
):
  | {
      content: string;
      connector: string;
      label: string;
      icon: string;
      tone: 'info' | 'warning';
      replyTo?: string;
      outboundReceipt?: CloudBridgeOutboundReceiptV1;
      idempotencyKey?: string;
    }
  | undefined {
  try {
    const parsed = JSON.parse(content) as {
      type?: unknown;
      v?: unknown;
      status?: unknown;
      reason?: unknown;
      rolloverId?: unknown;
      failureStage?: unknown;
      message?: unknown;
      outboundReceipt?: unknown;
    };
    // Session rollover is provider execution detail. The response lifecycle
    // bubble owns its processing/terminal state, so never append a parallel
    // system row for pending, success, or failure.
    if (parsed.type === 'session_rollover_lifecycle') return undefined;
    if (typeof parsed.message !== 'string') return undefined;
    if (parsed.type === 'warning') {
      return {
        content: parsed.message ? `⚠️ ${parsed.message}` : '⚠️ Warning',
        connector: 'system-warning',
        label: '系统警告',
        icon: '⚠️',
        tone: 'warning',
      };
    }
    if (parsed.type === 'a2a_multi_target_serialized') {
      return {
        content: parsed.message,
        connector: 'a2a-routing-mode',
        label: '调度模式',
        icon: '🔀',
        tone: 'info',
      };
    }
    if (parsed.type === 'cloud_bridge_status') {
      const outboundReceipt = projectOutboundReceipt(parsed.outboundReceipt);
      const unavailable = outboundReceipt ? outboundReceipt.status !== 'sent' : parsed.status === 'unavailable';
      return {
        content: parsed.message,
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: unavailable ? '⚠️' : '☁️',
        tone: unavailable ? 'warning' : 'info',
        ...(outboundReceipt
          ? {
              replyTo: outboundReceipt.sourceMessageId,
              outboundReceipt,
            }
          : {}),
      };
    }
    return undefined;
  } catch (parseErr) {
    log.warn({ catId, err: parseErr }, 'Ignoring non-JSON user-facing system_info content');
    return undefined;
  }
}

type VisibleNotice = NonNullable<ReturnType<typeof parseVisibleNotice>>;

function normalizedFailureText(value: string): string {
  return value.replace(/^(?:⚠️\s*|Error:\s*)+/u, '').trim();
}

export function composeTerminalFailureContent(options: {
  catId: string;
  sourceMessageId?: string;
  reason: string;
  providerFailureText: string;
  systemInfoContents: readonly string[];
}): string {
  const details: string[] = [];
  const pushDetail = (value: string): void => {
    const normalized = normalizedFailureText(value);
    if (!normalized || details.some((detail) => normalizedFailureText(detail) === normalized)) return;
    details.push(value.trim());
  };
  pushDetail(options.providerFailureText);
  for (const content of options.systemInfoContents) {
    const notice = parseVisibleNotice(content, options.catId);
    if (notice?.connector === 'system-warning') pushDetail(notice.content);
  }
  return [
    `@${options.catId} 处理失败（${options.reason}）。`,
    ...(options.sourceMessageId ? [`来源消息：${options.sourceMessageId}。`] : []),
    ...details,
  ].join('\n\n');
}

function duplicatesTerminalFailure(notice: VisibleNotice, terminalFailureText: string | undefined): boolean {
  return (
    notice.connector === 'system-warning' &&
    typeof terminalFailureText === 'string' &&
    normalizedFailureText(terminalFailureText).includes(normalizedFailureText(notice.content))
  );
}

async function appendVisibleNotice(
  messageStore: IMessageStore,
  threadId: string,
  notice: VisibleNotice,
  catId: string,
  expectedSourceMessageId: string | undefined,
  expectedDispatchInvocationId: string | undefined,
): Promise<void> {
  const outboundReceipt = notice.outboundReceipt
    ? await validateOutboundReceipt({
        messageStore,
        threadId,
        catId,
        expectedSourceMessageId,
        expectedDispatchInvocationId,
        receipt: notice.outboundReceipt,
      })
    : undefined;
  await messageStore.append({
    from: { kind: 'system', service: 'system-info-warning' },
    userId: 'system',
    threadId,
    content: notice.content,
    mentions: [],
    timestamp: Date.now(),
    ...(notice.idempotencyKey ? { idempotencyKey: notice.idempotencyKey } : {}),
    ...(outboundReceipt ? { replyTo: outboundReceipt.sourceMessageId } : {}),
    source: {
      connector: notice.connector,
      label: notice.label,
      icon: notice.icon,
      meta: {
        presentation: 'system_notice',
        noticeTone: notice.tone,
        ...(outboundReceipt ? { cloudBridgeOutboundReceipt: outboundReceipt } : {}),
      },
    },
  });
}

async function validateOutboundReceipt(args: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  expectedSourceMessageId: string | undefined;
  expectedDispatchInvocationId: string | undefined;
  receipt: CloudBridgeOutboundReceiptV1;
}): Promise<CloudBridgeOutboundReceiptV1 | undefined> {
  const { receipt } = args;
  if (
    !args.expectedSourceMessageId ||
    receipt.sourceMessageId !== args.expectedSourceMessageId ||
    !args.expectedDispatchInvocationId ||
    receipt.dispatchInvocationId !== args.expectedDispatchInvocationId ||
    receipt.targetCatId !== args.catId
  ) {
    log.warn(
      {
        threadId: args.threadId,
        catId: args.catId,
        sourceMessageId: receipt.sourceMessageId,
        dispatchInvocationId: receipt.dispatchInvocationId,
      },
      'Dropping cloud outbound receipt with mismatched server dispatch context',
    );
    return undefined;
  }
  const source = await resolveVisibleReplyParent(args.messageStore, receipt.sourceMessageId, {
    threadId: args.threadId,
    viewer: { type: 'cat', catId: createCatId(args.catId) },
    publicReply: true,
  });
  if (!source) return undefined;

  const from = messageFrom(source);
  const senderMatches =
    receipt.sourceSender.kind === 'user'
      ? from.kind === 'user' && from.userId === receipt.sourceSender.id
      : from.kind === 'agent' && from.catId === createCatId(receipt.sourceSender.id);
  if (!senderMatches) return undefined;
  if (receipt.sourceSender.invocationId) {
    const storedInvocationIds = new Set(
      [source.extra?.stream?.turnInvocationId, source.extra?.stream?.invocationId].filter((value): value is string =>
        Boolean(value),
      ),
    );
    if (!storedInvocationIds.has(receipt.sourceSender.invocationId)) return undefined;
  }
  return receipt;
}

function recordPersistenceFailure(
  catId: string,
  persistErr: unknown,
  persistenceContext: PersistenceContext | undefined,
): void {
  log.error({ catId, err: persistErr }, 'Failed to persist user-facing system_info notice');
  if (!persistenceContext) return;
  persistenceContext.failed = true;
  persistenceContext.errors.push({
    catId,
    error: persistErr instanceof Error ? persistErr.message : String(persistErr),
  });
}

export async function persistUserFacingSystemInfoNotices(options: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  contents: readonly string[];
  expectedSourceMessageId?: string;
  expectedDispatchInvocationId?: string;
  /** Exact provider failure already persisted in the lifecycle response body. */
  terminalFailureText?: string;
  persistenceContext?: PersistenceContext;
}): Promise<void> {
  const {
    messageStore,
    threadId,
    catId,
    contents,
    expectedSourceMessageId,
    expectedDispatchInvocationId,
    terminalFailureText,
    persistenceContext,
  } = options;

  for (const content of contents) {
    const notice = parseVisibleNotice(content, catId);
    if (notice == null) continue;
    if (duplicatesTerminalFailure(notice, terminalFailureText)) continue;

    try {
      await appendVisibleNotice(
        messageStore,
        threadId,
        notice,
        catId,
        expectedSourceMessageId,
        expectedDispatchInvocationId,
      );
    } catch (persistErr) {
      recordPersistenceFailure(catId, persistErr, persistenceContext);
    }
  }
}
