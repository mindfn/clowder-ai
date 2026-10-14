'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { apiFetch } from '@/utils/api-client';
import { executionDetailCopy } from './execution-detail.shell-copy';
import { clearExecutionDetailRequest, useExecutionDetailRequest } from './execution-detail-request';
import { ManagedExecutionStopControl } from './ManagedExecutionStopControl';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
interface CommandDetail {
  command: string;
  startedAt: number;
}
/** Consume the original hold owner projection, including its visibility boundary and exact task generation. */
function commandDetail(
  value: unknown,
  execution: Pick<ActiveExecutionProjection, 'executionId' | 'catId' | 'startedAt'>,
): CommandDetail | null {
  const body = record(value);
  const access = record(body?.access);
  const lifecycle = record(body?.lifecycle);
  const command = record(lifecycle?.managedCommand);
  if (
    body?.taskId !== execution.executionId ||
    body.catId !== execution.catId ||
    access?.lifecycleVisibility !== 'full' ||
    lifecycle?.mode !== 'wake_when' ||
    command?.state !== 'command_running' ||
    command.startedAt !== execution.startedAt ||
    typeof command.command !== 'string' ||
    command.command.length === 0
  )
    return null;
  return { command: command.command, startedAt: execution.startedAt };
}

export function ManagedExecutionDetail({ threadId }: { threadId?: string }) {
  const target = useExecutionDetailRequest();
  const candidate = useActiveExecutionStore((state) =>
    target ? state.executionsByKey[target.executionKey] : undefined,
  );
  const execution =
    candidate &&
    target &&
    candidate.kind === target.identity.kind &&
    candidate.executionId === target.identity.executionId &&
    candidate.threadId === target.identity.threadId &&
    candidate.catId === target.identity.catId &&
    candidate.startedAt === target.identity.startedAt
      ? candidate
      : undefined;
  const words = useShellCopy(executionDetailCopy);
  const language = useShellLanguage();
  const [detail, setDetail] = useState<{ key: string; value: CommandDetail | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const belongs = target && target.hostThreadId === threadId;
  const key = belongs ? `${target.revision}:${target.executionKey}:${attempt}` : null;
  const kind = execution?.kind;
  const executionId = execution?.executionId;
  const catId = execution?.catId;
  const startedAt = execution?.startedAt;
  const identity = useMemo(
    () =>
      kind === 'managed_command' && executionId && catId && startedAt !== undefined
        ? { executionId, catId, startedAt }
        : null,
    [kind, executionId, catId, startedAt],
  );
  useEffect(() => {
    if (!key || !identity) return;
    let disposed = false;
    void apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(identity.executionId)}/status`)
      .then(async (response) => (response.ok ? commandDetail(await response.json(), identity) : null))
      .catch(() => null)
      .then((value) => {
        if (!disposed) setDetail({ key, value });
      });
    return () => {
      disposed = true;
    };
  }, [key, identity]);
  useEffect(() => {
    if (!key) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    ref.current?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The focused original overlay owns its keys, including older owners without a dialog role.
      if (event.target instanceof Element && !ref.current?.contains(event.target)) return;
      if (document.querySelector('[role="dialog"], [data-v2-workspace-menu]:not([hidden])')) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      clearExecutionDetailRequest();
    };
    document.addEventListener('keydown', close, true);
    return () => document.removeEventListener('keydown', close, true);
  }, [key]);
  if (!belongs || !key) return null;
  const loading = execution && detail?.key !== key;
  const value = execution && detail?.key === key ? detail.value : null;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="home-card home-execution-detail"
      data-testid="workspace-execution-detail"
      aria-label={words.title}
    >
      <header className="home-card-head">
        <h3 className="home-card-title text-sm">{words.title}</h3>
        <button type="button" className="home-btn shell-focusable ml-auto" onClick={clearExecutionDetailRequest}>
          {words.close}
        </button>
      </header>
      {loading ? (
        <output className="text-xs text-cafe-muted">{words.loading}</output>
      ) : value && execution ? (
        <>
          <dl className="space-y-2 text-xs text-cafe-secondary">
            <div>
              <dt className="text-cafe-muted">{words.command}</dt>
              <dd>
                <pre className="whitespace-pre-wrap break-all">{value.command}</pre>
              </dd>
            </div>
            <div>
              <dt className="text-cafe-muted">{words.started}</dt>
              <dd>
                <time dateTime={new Date(value.startedAt).toISOString()}>
                  {new Date(value.startedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-cafe-muted">{words.source}</dt>
              <dd>
                <ThreadChatLink threadId={execution.threadId} className="shell-focusable underline">
                  {execution.threadTitle ?? execution.threadId}
                </ThreadChatLink>
              </dd>
            </div>
          </dl>
          <ManagedExecutionStopControl key={key} execution={execution} returnFocusRef={ref} />
        </>
      ) : (
        <div className="text-xs text-cafe-secondary">
          <output>{words.unavailable}</output>
          <button
            type="button"
            onClick={() => {
              setDetail(null);
              setAttempt(attempt + 1);
            }}
            className="home-btn shell-focusable"
          >
            {words.retry}
          </button>
        </div>
      )}
    </section>
  );
}
