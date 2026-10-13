'use client';
import { useMemo } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { executionRowCopy } from '@/components/execution-row/execution-row.shell-copy';
import { SessionChainPanel, type SessionChainProjection } from '@/components/SessionChainPanel';
import { useShellCopy } from '@/components/shell/shell-copy';
import {
  canonicalLauncherDestination,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import { useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { formatElapsed, homeActivityLabel } from './format';
import { useHomeClock } from './use-home-clock';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

export function HomeStatusSummary({
  threadId,
  onSelectDestination,
}: {
  threadId?: string;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
}) {
  const t = useShellCopy(workspaceV3Copy);
  const activity = useShellCopy(executionRowCopy);
  const { getCatById } = useCatData();
  const liveness = useThreadLiveness(threadId ?? null);
  const executions = useActiveExecutionStore((state) => state.executionsByKey);
  const current = useMemo(
    () =>
      Object.values(executions)
        .filter((run) => run.threadId === threadId)
        .sort((a, b) => a.startedAt - b.startedAt || a.executionId.localeCompare(b.executionId)),
    [executions, threadId],
  );
  const now = useHomeClock(current.length > 0, 1000);
  const first = current[0];
  const activeCats = [...new Set(current.map((run) => run.catId))];
  const cat = first ? getCatById(first.catId) : undefined;
  const label = cat?.nickname?.trim() || cat?.displayName || first?.catId;
  const select = () => onSelectDestination({ ...canonicalLauncherDestination('host', 'status'), label: t.status });
  function content(owner?: SessionChainProjection) {
    const session = owner?.sessions.filter((item) => item.catId === first?.catId).sort((a, b) => b.seq - a.seq)[0];
    const state = first
      ? first.kind === 'managed_command'
        ? activity.status.managed(label ?? first.catId, homeActivityLabel(first.activity, activity.activity), '', '')
        : activity.status.working(label ?? first.catId, '', '')
      : t.noSession;
    return (
      <button
        type="button"
        data-testid="workspace-home-status-summary"
        className="home-status-summary shell-focusable text-compact"
        onClick={select}
      >
        {first && (
          <span className="home-status-avatars" aria-hidden="true">
            {activeCats.slice(0, 3).map((catId) => (
              <CatAvatar key={catId} catId={catId} size={20} ring="none" />
            ))}
          </span>
        )}
        <span className="min-w-0 truncate">
          {owner?.loadError ? t.sessionUnavailable : owner?.loading && !first ? t.sessionLoading : state}
          {first && ` · ${formatElapsed(now - first.startedAt)}`}
          {session && ` · ${t.segment(session.seq)}`}
          {activeCats.length > 1 && ` · ${t.otherCats(activeCats.length - 1)}`}
        </span>
        <span aria-hidden="true">›</span>
      </button>
    );
  }
  return (
    <section className="home-section" aria-labelledby="home-status-title">
      <header className="home-card-head">
        <h2 id="home-status-title" className="home-card-title text-sm">
          {t.status}
        </h2>
        <button type="button" className="home-all shell-focusable ml-auto text-xs" onClick={select}>
          {t.all} ›
        </button>
      </header>
      {threadId ? (
        <SessionChainPanel
          threadId={threadId}
          catInvocations={liveness.catInvocations}
          activeInvocations={liveness.activeInvocations}
          renderProjection={content}
          refreshOnRunEnd
        />
      ) : (
        content()
      )}
    </section>
  );
}
