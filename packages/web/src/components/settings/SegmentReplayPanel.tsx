'use client';

/**
 * F257 Console 判据④ — True-scene replay panel for a segment observation.
 *
 * Loads `/api/segment-lifeline/:segmentId/replay` and displays event-time
 * content, template provenance, variable bindings, guard events, and
 * surrounding conversation context. Provenance gaps are rendered explicitly
 * (legacy-missing / invalid-present / unavailable).
 */

import type { SegmentReplayResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsText } from './primitives';

interface ReplayPanelProps {
  segmentId: string;
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
}

const GAP_LABEL: Record<string, string> = {
  'legacy-missing': '旧数据缺失',
  'invalid-present': '字段损坏',
  unavailable: '不可获取',
};

const formatTs = (ms: number) => new Date(ms).toLocaleString();

export function SegmentReplayPanel({
  segmentId,
  threadId,
  turnId,
  timestamp,
  catId,
  pipelineStatus,
}: ReplayPanelProps) {
  const [data, setData] = useState<SegmentReplayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const fetchReplay = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ threadId, turnId });
      const res = await apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}/replay?${query}`);
      if (id !== reqRef.current) return;
      if (!res.ok) {
        setError('回放加载失败');
        return;
      }
      setData((await res.json()) as SegmentReplayResponse);
    } catch {
      if (id === reqRef.current) setError('网络错误');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [segmentId, threadId, turnId]);

  useEffect(() => {
    fetchReplay();
    return () => {
      reqRef.current++;
    };
  }, [fetchReplay]);

  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-elevated-bg)] p-3">
        <SettingsText as="p" variant="xs" tone="muted">
          加载回放…
        </SettingsText>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-elevated-bg)] p-3">
        <SettingsText as="p" variant="xs" tone="red">
          {error ?? '回放数据为空'}
        </SettingsText>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-elevated-bg)] p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge tone={pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
          {pipelineStatus}
        </SettingsBadge>
        <span className="text-cafe-muted">@{catId}</span>
        <span className="ml-auto text-cafe-muted">{formatTs(timestamp)}</span>
      </div>

      <ReplayField label="现场内容" gap={data.contentGap}>
        {data.content != null ? (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--console-card-bg)] p-2 font-mono text-cafe">
            {data.content}
          </pre>
        ) : null}
      </ReplayField>

      <ReplayField label="模板来源" gap={data.templateRefGap}>
        {data.templateRef != null ? <span className="font-mono text-cafe-secondary">{data.templateRef}</span> : null}
      </ReplayField>

      <ReplayField label="版本" gap={data.versionGap}>
        {data.version != null ? <span className="text-cafe-secondary">v{data.version}</span> : null}
      </ReplayField>

      <ReplayField label="变量绑定" gap={data.templateVarsGap}>
        {data.templateVars != null ? (
          <div className="space-y-1">
            {Object.entries(data.templateVars).map(([key, value]) => (
              <div key={key} className="grid grid-cols-[120px_1fr] gap-2">
                <span className="truncate font-mono text-cafe-muted">{key}</span>
                <span className="truncate font-mono text-cafe-secondary">{value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </ReplayField>

      <ReplayField label="守卫事件" gap={data.guardEventsGap}>
        {data.guardEvents.length === 0 ? (
          <SettingsText as="p" variant="xs" tone="muted" className="italic">
            该时段无相关 guard 事件
          </SettingsText>
        ) : (
          <div className="space-y-1">
            {data.guardEvents.map((ev) => (
              <div
                key={ev.eventId}
                className="flex items-center gap-2 rounded-lg bg-[var(--console-card-bg)] px-2 py-1"
              >
                <SettingsBadge tone="amber" size="xxs">
                  {ev.kind}
                </SettingsBadge>
                <span className="font-mono text-cafe-secondary">{ev.guardId}</span>
                <span className="ml-auto text-cafe-muted">{formatTs(ev.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </ReplayField>

      <ReplayField label="上下文消息" gap={data.surroundingMessagesGap}>
        {data.surroundingMessages != null ? (
          <div className="max-h-[240px] space-y-1 overflow-auto">
            {data.surroundingMessages.map((msg) => (
              <div key={msg.messageId} className="rounded-lg bg-[var(--console-card-bg)] px-2 py-1.5">
                <div className="mb-0.5 flex items-center gap-2">
                  <SettingsBadge tone={msg.role === 'user' ? 'blue' : 'slate'} size="xxs">
                    {msg.role}
                  </SettingsBadge>
                  {msg.catId && <span className="text-cafe-muted">@{msg.catId}</span>}
                  <span className="ml-auto text-cafe-muted">{formatTs(msg.timestamp)}</span>
                </div>
                <div className="pl-1 text-cafe-secondary">{msg.contentPreview}</div>
              </div>
            ))}
          </div>
        ) : null}
      </ReplayField>
    </div>
  );
}

function ReplayField({ label, gap, children }: { label: string; gap: string | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          {label}
        </SettingsText>
        {gap && (
          <SettingsBadge tone="amber" size="xxs">
            {GAP_LABEL[gap] ?? gap}
          </SettingsBadge>
        )}
      </div>
      {children}
    </div>
  );
}
