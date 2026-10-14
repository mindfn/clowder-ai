'use client';

import { type CSSProperties, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { catColorVar } from '@/lib/cat-slug';
import { useChatStore } from '@/stores/chatStore';
import { CatNameplate } from '../CatNameplate';
import type { RightStatusPanelProps } from '../RightStatusPanel';
import { SessionIdTag } from '../SessionChainInputs';
import type { SessionChainProjection, SessionSummary } from '../SessionChainPanel';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { createAgentRunSurface } from '../workbench/real-surface-adapters';
import { SessionRowV2 } from './SessionRowV2';
import type { StatusLastRun } from './status-run-history';

export function StatusCatGroupV2({
  catId,
  owner,
  props,
  lastRun,
  onView,
}: {
  catId: string;
  owner: SessionChainProjection;
  props: RightStatusPanelProps;
  lastRun?: StatusLastRun;
  onView: (session: SessionSummary) => void;
}) {
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const running = owner.runningCatIds.has(catId);
  const invocation = props.catInvocations[catId];
  // Message ordering and client telemetry clocks do not establish a shared run identity.
  const slot = Object.entries(props.activeInvocations ?? {}).find(([, item]) => item.catId === catId);
  const elapsed = useElapsedTime(running ? (slot?.[1].startedAt ?? invocation?.startedAt) : undefined);
  const seconds = Math.floor(elapsed / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  // Legacy hydration keys are presentation bookkeeping, not copyable runtime IDs.
  const parentId = slot?.[0];
  const observedParentId = parentId?.startsWith('hydrated-') ? undefined : parentId;
  const invocationId = running
    ? invocation?.invocationId === parentId
      ? (invocation?.turnInvocationId ?? observedParentId)
      : observedParentId
    : (lastRun?.invocationId ?? invocation?.turnInvocationId ?? invocation?.invocationId);
  const trajectoryId = running
    ? invocation?.invocationId === parentId
      ? invocation.turnInvocationId
      : undefined
    : (lastRun?.invocationId ?? invocation?.turnInvocationId);
  const sessions = owner.sessions.filter((session) => session.catId === catId);
  const current = sessions.filter((session) => session.status === 'active');
  const archived = sessions
    .filter((session) => session.status !== 'active')
    .sort((a, b) => (b.sealedAt ?? b.createdAt) - (a.sealedAt ?? a.createdAt));
  const visibleArchived = archived.filter((session) => !owner.retryFragmentIds.has(session.id));
  const collapsedRetries = archived.length - visibleArchived.length;
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = props.catStatuses[catId];
  const label =
    status === 'error'
      ? '异常'
      : running
        ? status === 'spawning'
          ? '启动中'
          : status === 'alive_but_silent'
            ? '静默等待'
            : status === 'suspected_stall'
              ? '疑似卡住'
              : '运行中'
        : '空闲';
  const dot =
    status === 'error' ? 'var(--semantic-critical)' : running ? 'var(--semantic-success)' : 'var(--cafe-text-muted)';
  const lastRunAt =
    lastRun?.observedAt ??
    (invocation?.startedAt && invocation.durationMs != null ? invocation.startedAt + invocation.durationMs : undefined);
  return (
    <section
      data-testid="status-cat-group"
      data-cat-id={catId}
      data-running={running}
      className="status-v2-cat"
      style={
        {
          '--status-cat-color': catColorVar(catId, 'primary'),
          '--status-cat-surface': catColorVar(catId, 'surface'),
        } as CSSProperties
      }
    >
      <div className="status-v2-cat-heading">
        <CatNameplate catId={catId} name={cat ? formatCatName(cat) : catId} />
        <span className="status-v2-state">
          <span className="status-v2-dot" style={{ background: dot }} />
          {label}
          {running
            ? elapsed > 0
              ? ` · ${duration}`
              : ''
            : lastRunAt
              ? ` · 上次运行 ${new Date(lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
              : ''}
        </span>
        {trajectoryId && (
          <button
            type="button"
            className="status-v2-run-link"
            onClick={() => {
              // Match chat: the original resolver owns canonical session identity.
              useF307ExperienceWorkbenchStore.getState().dispatch({
                type: 'open-surface',
                surface: createAgentRunSurface({ threadId: props.threadId, invocationId: trajectoryId, catId }),
                entitlement: { kind: 'user', reason: 'sidecar-action' },
              });
              useChatStore.getState().setRightPanelMode('workspace');
              useChatStore.getState().setRightPanelOpen(true);
            }}
          >
            {running ? '查看运行' : '查看上次运行'} ›
          </button>
        )}
      </div>
      {invocationId && (
        <div className="status-v2-runtime status-v2-muted">
          <span>{running ? '运行 ID' : '上次运行 ID'}</span>
          <SessionIdTag id={invocationId} label="运行 ID" />
        </div>
      )}
      {current.map((session) => (
        <SessionRowV2
          key={session.id}
          session={session}
          owner={owner}
          invocation={invocation}
          threadId={props.threadId}
          onView={onView}
        />
      ))}
      {current.length === 0 && (
        <p className="status-v2-muted">
          {owner.loading ? '正在读取会话…' : owner.loadError ? '会话记录暂不可用' : '没有未封存的会话'}
        </p>
      )}
      {archived.length > 0 && (
        <div className="status-v2-history">
          <button
            type="button"
            aria-expanded={historyOpen}
            data-testid={`sealed-toggle-${catId}`}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            {historyOpen ? '▾' : '›'} 已封存的会话 {archived.length}
          </button>
          {historyOpen && collapsedRetries > 0 && (
            <p className="status-v2-muted">{collapsedRetries} 次重试片段（已折叠 · 各 0 条消息）</p>
          )}
          {historyOpen &&
            visibleArchived.map((session) => (
              <SessionRowV2
                key={session.id}
                session={session}
                owner={owner}
                threadId={props.threadId}
                onView={onView}
              />
            ))}
        </div>
      )}
    </section>
  );
}
