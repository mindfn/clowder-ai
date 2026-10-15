'use client';

import type { CatInvocationInfo, ContextHealthData } from '@/stores/chat-types';
import { BindSessionInput, SessionIdTag } from '../SessionChainInputs';
import {
  runtimeLifecycleLabel,
  type SessionChainProjection,
  type SessionSummary,
  sealReasonLabel,
} from '../SessionChainPanel';
import { formatTokenCount } from '../status-helpers';
import { SessionContextV2 } from './SessionContextV2';

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function SessionRowV2({
  session,
  owner,
  invocation,
  threadId,
  onView,
}: {
  session: SessionSummary;
  owner: SessionChainProjection;
  invocation?: CatInvocationInfo;
  threadId: string;
  onView: (session: SessionSummary) => void;
}) {
  const unsealed = session.status === 'active';
  const running = owner.runningCatIds.has(session.catId);
  const count = owner.unsealedCountByCat.get(session.catId) ?? 0;
  const ambiguous = count > 1;
  const firstUnsealed = owner.sessions.find((record) => record.catId === session.catId && record.status === 'active');
  // Same attribution as the existing owner: live telemetry only belongs to the one unsealed running record.
  const live = unsealed && running && count === 1;
  const health: ContextHealthData | undefined =
    (live ? invocation?.contextHealth : undefined) ??
    (session.contextHealth ? { ...session.contextHealth, measuredAt: session.createdAt } : undefined);
  const usage = (live ? invocation?.usage : undefined) ?? session.lastUsage;
  const cache =
    usage?.cacheReadTokens && usage.inputTokens ? Math.round((usage.cacheReadTokens / usage.inputTokens) * 100) : null;
  const cannotTarget = owner.isStale || running || ambiguous;
  const switchWarning = session.runtimeSession?.unexpectedRuntimeSessionSwitch;
  return (
    <article className="status-v2-session" data-session-id={session.id} data-session-lifecycle={session.status}>
      <div className="status-v2-session-title">
        <strong>会话 #{session.seq + 1}</strong>
        <SessionIdTag id={session.cliSessionId ?? session.id} />
      </div>
      <p className="status-v2-muted">
        {age(session.createdAt)}开始 · {session.messageCount} 条消息 ·{' '}
        {session.compressionCount == null
          ? '压缩次数未知'
          : session.compressionCount === 0
            ? '未压缩'
            : `已压缩 ${session.compressionCount} 次`}
      </p>
      {!unsealed && (
        <p className="status-v2-muted">
          {session.status === 'sealed' ? '已封存' : '封存中'}
          {session.sealedAt ? ` · ${age(session.sealedAt)}封存` : ''}
          {session.sealReason ? ` · ${sealReasonLabel(session.sealReason)}` : ''}
        </p>
      )}
      {session.runtimeSession && (
        <div className="status-v2-runtime status-v2-muted">
          <span>运行会话</span>
          <SessionIdTag id={session.runtimeSession.runtimeSessionId} />
          <span>{session.runtimeSession.runtime}</span>
          <span>{runtimeLifecycleLabel(session.runtimeSession.lifecycleState)}</span>
          {session.runtimeSession.runtimeConversationId && (
            <SessionIdTag id={session.runtimeSession.runtimeConversationId} label="运行对话 ID" />
          )}
        </div>
      )}
      {switchWarning && (
        <div className="status-v2-notice">
          <span>运行会话意外切换</span>
          <SessionIdTag id={switchWarning.previousRuntimeSessionId} />
          <span>→</span>
          <SessionIdTag id={switchWarning.currentRuntimeSessionId} />
        </div>
      )}
      {usage && (
        <p className="status-v2-tokens">
          {usage.inputTokens != null && (
            <span title="输入 token，可能累计多次模型调用；不等于上下文占用">
              {formatTokenCount(usage.inputTokens)} 输入
            </span>
          )}
          {usage.outputTokens != null && <span>{formatTokenCount(usage.outputTokens)} 输出</span>}
          {cache != null && <span>{cache}% 缓存命中</span>}
          {usage.costUsd != null && <span>${usage.costUsd.toFixed(4)}</span>}
        </p>
      )}
      <SessionContextV2 catId={session.catId} health={health} />
      {ambiguous && unsealed && firstUnsealed?.id === session.id && (
        <p className="status-v2-session-warning">
          <span className="status-v2-dot" style={{ background: 'var(--semantic-warning)' }} />
          <span>有 {count} 个未封存的会话，压缩前请确认当前使用的会话</span>
        </p>
      )}
      {ambiguous && session.status === 'sealed' && (
        <p className="status-v2-muted">多个未封存会话，暂不能恢复；先确认并封存多余会话</p>
      )}
      <div className="status-v2-actions">
        {unsealed && session.cliSessionId && (
          <button
            type="button"
            data-testid={`compact-native-session-${session.id}`}
            disabled={cannotTarget || owner.compactingSessionId !== null}
            onClick={() => void owner.onCompact(session)}
          >
            {owner.compactingSessionId === session.id ? '压缩中…' : '压缩上下文'}
          </button>
        )}
        {unsealed && (
          <button
            type="button"
            data-testid={`seal-session-${session.id}`}
            disabled={owner.isStale || running || owner.sealingSessionId !== null}
            onClick={() => void owner.onSeal(session.id)}
          >
            {owner.sealingSessionId === session.id ? '封存中…' : '封存会话'}
          </button>
        )}
        {!unsealed && (
          <button type="button" data-testid={`view-session-${session.id}`} onClick={() => onView(session)}>
            查看历史
          </button>
        )}
        {session.status === 'sealed' && (
          <button
            type="button"
            data-testid={`restore-session-${session.id}`}
            disabled={cannotTarget || owner.restoringSessionId !== null}
            onClick={() => void owner.onRestore(session)}
          >
            {owner.restoringSessionId === session.id ? '恢复中…' : '恢复为当前'}
          </button>
        )}
        {unsealed && threadId !== 'default' && (
          <BindSessionInput
            threadId={threadId}
            catId={session.catId}
            disabled={cannotTarget}
            onBound={owner.onRefresh}
          />
        )}
        {running && <span className="status-v2-muted">停止运行后才能{unsealed ? '压缩、绑定或封存' : '恢复'}</span>}
      </div>
    </article>
  );
}
