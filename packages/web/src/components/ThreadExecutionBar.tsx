'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { catColorVar } from '@/lib/cat-slug';
import type { AppServerLifecycleSnapshot, AppServerLifecycleStage, CatInvocationInfo } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { isSilentActiveTurn } from './capability-tip-placement';
import { deriveActiveCats } from './status-helpers';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

const APP_SERVER_STAGE_LABELS: Record<AppServerLifecycleStage, string> = {
  child_spawned: '启动子进程',
  initialized: '初始化 app-server',
  thread_ready: '会话已就绪',
  turn_accepted: '回合已接受',
  active: '运行回合',
  completed: '回合完成',
  interrupted: '回合已中断',
  failed: '回合失败',
  closing: '清理进程',
  closed: '进程已关闭',
};

function formatActivityAge(lastActivityAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

interface ThreadExecutionBarProps {
  threadId?: string;
}

/** F122B AC-B8+B9: Per-cat execution status bar with member Stop controls.
 *  B8/B9 polish: cat names use formatCatName() — "品种（variant）" format, colors from cat-config. */
export function ThreadExecutionBar({ threadId }: ThreadExecutionBarProps) {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const {
    activeInvocations,
    catInvocations,
    hasActive: hasActiveInvocation,
    intentMode,
    targetCats,
  } = useThreadLiveness(effectiveThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);

  const activeCats = deriveActiveCats({
    targetCats,
    activeInvocations,
    hasActiveInvocation,
    intentMode,
  }).map((catId) => ({
    catId,
    startedAt: getStartedAt(catId, activeInvocations, catInvocations),
    lifecycle: catInvocations[catId]?.appServerLifecycle,
  }));

  // Build display info from cat-config (dynamic, not hardcoded)
  const catDisplayMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const { catId } of activeCats) {
      const cat = getCatById(catId);
      if (cat) {
        map.set(catId, {
          label: formatCatName(cat),
          color: catColorVar(cat.id, 'primary'),
        });
      } else {
        map.set(catId, { label: catId, color: 'var(--cafe-accent)' });
      }
    }
    return map;
  }, [activeCats, getCatById]);

  // Auto-update elapsed time every second when cats are active
  useEffect(() => {
    if (activeCats.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeCats.length]);

  const handleStopCat = useCallback(
    async (catId: string) => {
      if (!effectiveThreadId) return;
      try {
        const response = await apiFetch(`/api/threads/${effectiveThreadId}/cancel/${catId}`, { method: 'POST' });
        if (!response.ok) throw new Error(`member stop request failed (${response.status})`);
      } catch {
        useToastStore.getState().addToast({
          type: 'error',
          title: '停止失败',
          message: '未能停止该成员的运行，请稍后重试。',
          duration: 5000,
        });
      }
    },
    [effectiveThreadId],
  );

  if (activeCats.length === 0) return null;

  return (
    <div className="console-divider-b">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
        <span className="text-cafe-muted font-medium shrink-0">执行中</span>
        {activeCats.map(({ catId, startedAt, lifecycle }) => {
          const info = catDisplayMap.get(catId) ?? { label: catId, color: 'var(--cafe-accent)' };
          return (
            <CatStatusChip
              key={catId}
              catId={catId}
              label={info.label}
              color={info.color}
              startedAt={startedAt}
              lifecycle={lifecycle}
              onStop={handleStopCat}
            />
          );
        })}
      </div>
    </div>
  );
}

function getStartedAt(
  catId: string,
  activeInvocations: ActiveInvocationSlots,
  catInvocations: Record<string, CatInvocationInfo>,
) {
  const slot = Object.values(activeInvocations).find((inv) => inv.catId === catId);
  if (typeof slot?.startedAt === 'number') return slot.startedAt;

  const invocationStartedAt = catInvocations[catId]?.startedAt;
  if (typeof invocationStartedAt === 'number') return invocationStartedAt;

  return Date.now();
}

function CatStatusChip({
  catId,
  label,
  color,
  startedAt,
  lifecycle,
  onStop,
}: {
  catId: string;
  label: string;
  color: string;
  startedAt: number;
  lifecycle?: AppServerLifecycleSnapshot;
  onStop: (catId: string) => void;
}) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const appServerStalled = isSilentActiveTurn(lifecycle);

  return (
    <span
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cafe-surface/50"
      data-app-server-stalled={appServerStalled ? 'true' : undefined}
    >
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-cafe-secondary font-medium">{label}</span>
      {lifecycle && (
        <span className={appServerStalled ? 'text-conn-amber-text' : 'text-cafe-muted'}>
          {APP_SERVER_STAGE_LABELS[lifecycle.stage]} ·{' '}
          {appServerStalled ? '可能在等待模型' : `活动 ${formatActivityAge(lifecycle.lastActivityAt)}`}
        </span>
      )}
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
      <button
        type="button"
        aria-label={`停止 ${label}`}
        onClick={() => onStop(catId)}
        className="ml-0.5 text-cafe-muted hover:text-conn-red-text transition-colors"
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </span>
  );
}
