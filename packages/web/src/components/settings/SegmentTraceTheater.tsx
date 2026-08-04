'use client';

import { useState } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentReplayPanel } from './SegmentReplayPanel';

export interface TraceTheaterObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

export function SegmentTraceTheater({
  segmentId,
  observations,
  capped,
}: {
  segmentId: string;
  observations: TraceTheaterObservation[];
  capped?: boolean;
}) {
  const [selected, setSelected] = useState<TraceTheaterObservation | null>(null);
  return (
    <div className="space-y-3" data-testid="segment-trace-theater">
      <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          Tracing 回放剧场
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
          每一场都是完整 TraceEpisode。点击进入可查看当时的对话、实际注入内容、变量与工具结果。
        </SettingsText>
      </div>
      {observations.length === 0 ? (
        <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
          <SettingsText as="p" variant="xs" tone="muted">
            当前窗口暂无该段的 tracing 场次。
          </SettingsText>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {observations.map((observation) => (
            <button
              type="button"
              key={`${observation.threadId}:${observation.turnId}`}
              onClick={() => setSelected(observation)}
              className="rounded-xl bg-[var(--console-panel-bg)] p-3 text-left transition hover:brightness-95"
            >
              <div className="flex items-center gap-2">
                <SettingsBadge tone={observation.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
                  {observation.pipelineStatus === 'fired' ? '已注入' : '已观测'}
                </SettingsBadge>
                <span className="text-xs text-cafe-secondary">@{observation.catId}</span>
                {observation.version != null && (
                  <span className="ml-auto text-micro text-cafe-muted">v{observation.version}</span>
                )}
              </div>
              <div className="mt-2 text-xs text-cafe">{new Date(observation.timestamp).toLocaleString()}</div>
              <div className="mt-1 flex items-center justify-between text-micro text-cafe-muted">
                <span>{observation.charCount} chars</span>
                <span>进入回放现场 →</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {capped && (
        <SettingsText as="p" variant="xs" tone="muted">
          当前仅展示最近 100 场；窗口总计数仍为完整聚合。
        </SettingsText>
      )}
      {selected && (
        <SegmentReplayPanel
          segmentId={segmentId}
          threadId={selected.threadId}
          turnId={selected.turnId}
          timestamp={selected.timestamp}
          catId={selected.catId}
          pipelineStatus={selected.pipelineStatus}
          isOpen
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
